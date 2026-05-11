/**
 * Google Docs operation tools.
 *
 * In-place document edits via the documents.batchUpdate endpoint. The batch
 * model means each tool issues one or more typed requests (replaceAllText,
 * insertText, updateTextStyle, etc.) that the Docs API applies atomically.
 *
 * Tools provided:
 *   - find_and_replace: simple text find-and-replace
 *   - append_to_doc:    append text at the end of the document body
 *   - insert_at_heading: insert content after (or before) a heading by text
 *   - apply_text_style: bold/italic/underline/font/color on matched text
 */

import { z } from 'zod';
import type { docs_v1 } from 'googleapis';
import { getGoogleClients } from '../google.js';
import { log } from '../lib/retry.js';

// =========================================================================
// find_and_replace
// =========================================================================

export const findAndReplaceSchema = z.object({
  document_id: z.string().min(1).describe('Google Docs document ID.'),
  find: z.string().min(1).describe('Text to search for.'),
  replace: z.string().describe('Replacement text. May be empty string to delete matches.'),
  match_case: z
    .boolean()
    .default(false)
    .describe('If true, the search is case-sensitive.'),
  dry_run: z.boolean().default(false).describe('If true, counts occurrences via a scan but does not modify the document. Use to preview a large find-and-replace before committing.'),
});

export type FindAndReplaceInput = z.infer<typeof findAndReplaceSchema>;

export async function findAndReplace(input: FindAndReplaceInput): Promise<{
  document_id: string;
  occurrences_changed: number;
  dry_run: boolean;
}> {
  const { docs } = await getGoogleClients();

  if (input.dry_run) {
    const doc = await docs.documents.get({ documentId: input.document_id });
    const body = doc.data.body;
    let count = 0;
    const needle = input.match_case ? input.find : input.find.toLowerCase();
    for (const element of body?.content ?? []) {
      if (!element.paragraph) continue;
      const elems: docs_v1.Schema$ParagraphElement[] = element.paragraph.elements ?? [];
      const text = elems.map((e: docs_v1.Schema$ParagraphElement) => e.textRun?.content ?? '').join('');
      const haystack = input.match_case ? text : text.toLowerCase();
      let idx = 0;
      while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        count++;
        idx += needle.length;
      }
    }
    return {
      document_id: input.document_id,
      occurrences_changed: count,
      dry_run: true,
    };
  }

  log('info', 'destructive_op', { tool: 'find_and_replace', document_id: input.document_id, find_length: input.find.length });

  const result = await docs.documents.batchUpdate({
    documentId: input.document_id,
    requestBody: {
      requests: [
        {
          replaceAllText: {
            containsText: {
              text: input.find,
              matchCase: input.match_case,
            },
            replaceText: input.replace,
          },
        },
      ],
    },
  });

  const reply = result.data.replies?.[0]?.replaceAllText;
  const occurrencesChanged = reply?.occurrencesChanged ?? 0;

  return {
    document_id: input.document_id,
    occurrences_changed: occurrencesChanged,
    dry_run: false,
  };
}

// =========================================================================
// append_to_doc
// =========================================================================

export const appendToDocSchema = z.object({
  document_id: z.string().min(1).describe('Google Docs document ID.'),
  text: z.string().min(1).describe('Text to append at the end of the document.'),
  leading_newlines: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(2)
    .describe(
      'Number of newlines to insert before the text. Default 2 gives a blank line of separation.',
    ),
});

export type AppendToDocInput = z.infer<typeof appendToDocSchema>;

export async function appendToDoc(input: AppendToDocInput): Promise<{
  document_id: string;
  characters_inserted: number;
}> {
  const { docs } = await getGoogleClients();

  // Use endOfSegmentLocation to append. Robust to document length changes
  // between calls — no need to read the doc first.
  const prefix = '\n'.repeat(input.leading_newlines);
  const fullText = prefix + input.text;

  await docs.documents.batchUpdate({
    documentId: input.document_id,
    requestBody: {
      requests: [
        {
          insertText: {
            endOfSegmentLocation: {},
            text: fullText,
          },
        },
      ],
    },
  });

  return {
    document_id: input.document_id,
    characters_inserted: fullText.length,
  };
}

// =========================================================================
// insert_at_heading
// =========================================================================

export const insertAtHeadingSchema = z.object({
  document_id: z.string().min(1).describe('Google Docs document ID.'),
  heading_text: z
    .string()
    .min(1)
    .describe('Exact text of an existing heading to anchor the insertion to. Case-sensitive.'),
  content: z.string().min(1).describe('Text to insert.'),
  position: z
    .enum(['after', 'before'])
    .default('after')
    .describe(
      "Whether to insert immediately after the heading (typical) or immediately before. 'after' inserts at the start of the line following the heading; 'before' inserts at the start of the heading's line.",
    ),
  leading_newline: z
    .boolean()
    .default(true)
    .describe('If true, prepends a newline to the inserted content for separation.'),
});

export type InsertAtHeadingInput = z.infer<typeof insertAtHeadingSchema>;

export async function insertAtHeading(input: InsertAtHeadingInput): Promise<{
  document_id: string;
  inserted_at_index: number;
  characters_inserted: number;
}> {
  const { docs } = await getGoogleClients();

  // Read the document to find the heading's location.
  const doc = await docs.documents.get({
    documentId: input.document_id,
  });

  const body = doc.data.body;
  if (!body?.content) {
    throw new Error(`Document body is empty or unreadable.`);
  }

  // Walk top-level structural elements; find the first paragraph whose
  // text content matches the heading. We don't filter on headingId/style
  // here because users may anchor on body text in some workflows; matching
  // on text is the most forgiving approach.
  let foundStartIndex: number | null = null;
  let foundEndIndex: number | null = null;

  for (const element of body.content) {
    if (!element.paragraph) continue;
    const elements: docs_v1.Schema$ParagraphElement[] = element.paragraph.elements ?? [];
    const paragraphText = elements
      .map((e: docs_v1.Schema$ParagraphElement) => e.textRun?.content ?? '')
      .join('')
      .trim();
    if (paragraphText === input.heading_text) {
      foundStartIndex = element.startIndex ?? null;
      foundEndIndex = element.endIndex ?? null;
      break;
    }
  }

  if (foundStartIndex === null || foundEndIndex === null) {
    throw new Error(`Heading not found: "${input.heading_text}". Verify exact text and case.`);
  }

  // endIndex points one past the trailing newline. Inserting there places
  // content at the start of the next paragraph. For position='before' we use
  // startIndex which is the start of the heading's own paragraph.
  const insertIndex = input.position === 'after' ? foundEndIndex : foundStartIndex;
  const text = input.leading_newline ? '\n' + input.content : input.content;

  await docs.documents.batchUpdate({
    documentId: input.document_id,
    requestBody: {
      requests: [
        {
          insertText: {
            location: { index: insertIndex },
            text,
          },
        },
      ],
    },
  });

  return {
    document_id: input.document_id,
    inserted_at_index: insertIndex,
    characters_inserted: text.length,
  };
}

// =========================================================================
// apply_text_style
// =========================================================================

const textStyleSchema = z
  .object({
    bold: z.boolean().optional().describe('Make matched text bold.'),
    italic: z.boolean().optional().describe('Make matched text italic.'),
    underline: z.boolean().optional().describe('Underline matched text.'),
    strikethrough: z.boolean().optional().describe('Strike through matched text.'),
    font_size_pt: z.number().min(1).max(400).optional().describe('Set font size in points.'),
    foreground_hex: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional()
      .describe('Set text color as a 7-character hex string like "#1a73e8".'),
  })
  .strict();

export const applyTextStyleSchema = z.object({
  document_id: z.string().min(1).describe('Google Docs document ID.'),
  find: z.string().min(1).describe('Text to match for styling.'),
  style: textStyleSchema.describe('Style properties to apply.'),
  match_case: z.boolean().default(true).describe('Case-sensitive matching (recommended for styling).'),
});

export type ApplyTextStyleInput = z.infer<typeof applyTextStyleSchema>;

export async function applyTextStyle(input: ApplyTextStyleInput): Promise<{
  document_id: string;
  occurrences_styled: number;
}> {
  const { docs } = await getGoogleClients();

  const doc = await docs.documents.get({ documentId: input.document_id });
  const body = doc.data.body;
  if (!body?.content) {
    return { document_id: input.document_id, occurrences_styled: 0 };
  }

  const serialized = serializeBodyText(body);
  const compareHaystack = input.match_case ? serialized.text : serialized.text.toLowerCase();
  const compareNeedle = input.match_case ? input.find : input.find.toLowerCase();

  const matches: Array<{ startIndex: number; endIndex: number }> = [];
  let cursor = 0;
  while (cursor < compareHaystack.length) {
    const idx = compareHaystack.indexOf(compareNeedle, cursor);
    if (idx < 0) break;
    const docStart = serialized.offsetToDocIndex(idx);
    const docEnd = serialized.offsetToDocIndex(idx + input.find.length);
    matches.push({ startIndex: docStart, endIndex: docEnd });
    cursor = idx + input.find.length;
  }

  if (matches.length === 0) {
    return { document_id: input.document_id, occurrences_styled: 0 };
  }

  const { textStyle, fields } = buildTextStylePayload(input.style);
  if (!fields) {
    return { document_id: input.document_id, occurrences_styled: 0 };
  }

  await docs.documents.batchUpdate({
    documentId: input.document_id,
    requestBody: {
      requests: matches.map((m) => ({
        updateTextStyle: {
          range: { startIndex: m.startIndex, endIndex: m.endIndex },
          textStyle,
          fields,
        },
      })),
    },
  });

  return { document_id: input.document_id, occurrences_styled: matches.length };
}

// ---------- helpers ----------

interface SerializedBody {
  text: string;
  /** Maps a 0-based character offset in `text` to the corresponding Docs API index. */
  offsetToDocIndex(offset: number): number;
}

function serializeBodyText(body: docs_v1.Schema$Body): SerializedBody {
  interface Chunk { text: string; docIndex: number }
  const chunks: Chunk[] = [];
  for (const element of body.content ?? []) {
    const paragraph = element.paragraph;
    if (!paragraph) continue;
    for (const e of paragraph.elements ?? []) {
      const tr = e.textRun;
      if (!tr?.content) continue;
      chunks.push({ text: tr.content, docIndex: e.startIndex ?? 0 });
    }
  }
  const text = chunks.map((c) => c.text).join('');
  return {
    text,
    offsetToDocIndex(offset: number): number {
      let runningOffset = 0;
      for (const c of chunks) {
        const len = c.text.length;
        if (offset <= runningOffset + len) {
          return c.docIndex + (offset - runningOffset);
        }
        runningOffset += len;
      }
      const last = chunks[chunks.length - 1];
      return last ? last.docIndex + last.text.length : 0;
    },
  };
}

function buildTextStylePayload(style: z.infer<typeof textStyleSchema>): {
  textStyle: Record<string, unknown>;
  fields: string;
} {
  const textStyle: Record<string, unknown> = {};
  const fields: string[] = [];

  if (style.bold !== undefined) { textStyle['bold'] = style.bold; fields.push('bold'); }
  if (style.italic !== undefined) { textStyle['italic'] = style.italic; fields.push('italic'); }
  if (style.underline !== undefined) { textStyle['underline'] = style.underline; fields.push('underline'); }
  if (style.strikethrough !== undefined) { textStyle['strikethrough'] = style.strikethrough; fields.push('strikethrough'); }
  if (style.font_size_pt !== undefined) {
    textStyle['fontSize'] = { magnitude: style.font_size_pt, unit: 'PT' };
    fields.push('fontSize');
  }
  if (style.foreground_hex !== undefined) {
    const hex = style.foreground_hex.slice(1);
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    textStyle['foregroundColor'] = { color: { rgbColor: { red: r, green: g, blue: b } } };
    fields.push('foregroundColor');
  }

  return { textStyle, fields: fields.join(',') };
}

// =========================================================================
// apply_paragraph_style
// =========================================================================

const namedStyleEnum = z.enum([
  'NORMAL_TEXT',
  'TITLE',
  'SUBTITLE',
  'HEADING_1',
  'HEADING_2',
  'HEADING_3',
  'HEADING_4',
  'HEADING_5',
  'HEADING_6',
]);

const alignmentEnum = z.enum(['START', 'CENTER', 'END', 'JUSTIFIED']);

export const applyParagraphStyleSchema = z.object({
  document_id: z.string().min(1).describe('Google Docs document ID.'),
  paragraph_text: z.string().min(1).describe('Exact text of the paragraph to restyle. Case-sensitive. First matching paragraph wins.'),
  named_style: namedStyleEnum.optional().describe('Promote the paragraph to a named style: TITLE, SUBTITLE, HEADING_1..HEADING_6, or NORMAL_TEXT.'),
  alignment: alignmentEnum.optional().describe('Paragraph alignment: START (left), CENTER, END (right), or JUSTIFIED.'),
  indent_start_pt: z.number().min(0).max(720).optional().describe('Left indent in points (1 inch = 72pt).'),
  indent_end_pt: z.number().min(0).max(720).optional().describe('Right indent in points.'),
  line_spacing_pct: z.number().min(50).max(400).optional().describe('Line spacing as a percentage (100 = single, 150 = 1.5x, 200 = double).'),
  space_above_pt: z.number().min(0).max(200).optional().describe('Space above the paragraph in points.'),
  space_below_pt: z.number().min(0).max(200).optional().describe('Space below the paragraph in points.'),
});

export type ApplyParagraphStyleInput = z.infer<typeof applyParagraphStyleSchema>;

export async function applyParagraphStyle(input: ApplyParagraphStyleInput): Promise<{
  document_id: string;
  matched_start_index: number;
  matched_end_index: number;
}> {
  const { docs } = await getGoogleClients();
  const doc = await docs.documents.get({ documentId: input.document_id });
  const body = doc.data.body;
  if (!body?.content) {
    throw new Error('Document body is empty or unreadable.');
  }

  let startIndex: number | null = null;
  let endIndex: number | null = null;
  for (const element of body.content) {
    if (!element.paragraph) continue;
    const elements: docs_v1.Schema$ParagraphElement[] = element.paragraph.elements ?? [];
    const paragraphText = elements
      .map((e: docs_v1.Schema$ParagraphElement) => e.textRun?.content ?? '')
      .join('')
      .replace(/\n$/, '');
    if (paragraphText === input.paragraph_text) {
      startIndex = element.startIndex ?? null;
      endIndex = element.endIndex ?? null;
      break;
    }
  }

  if (startIndex === null || endIndex === null) {
    throw new Error(`Paragraph not found: "${input.paragraph_text}". Verify exact text and case.`);
  }

  const paragraphStyle: docs_v1.Schema$ParagraphStyle = {};
  const fields: string[] = [];
  if (input.named_style) {
    paragraphStyle.namedStyleType = input.named_style;
    fields.push('namedStyleType');
  }
  if (input.alignment) {
    paragraphStyle.alignment = input.alignment;
    fields.push('alignment');
  }
  if (input.indent_start_pt !== undefined) {
    paragraphStyle.indentStart = { magnitude: input.indent_start_pt, unit: 'PT' };
    fields.push('indentStart');
  }
  if (input.indent_end_pt !== undefined) {
    paragraphStyle.indentEnd = { magnitude: input.indent_end_pt, unit: 'PT' };
    fields.push('indentEnd');
  }
  if (input.line_spacing_pct !== undefined) {
    paragraphStyle.lineSpacing = input.line_spacing_pct;
    fields.push('lineSpacing');
  }
  if (input.space_above_pt !== undefined) {
    paragraphStyle.spaceAbove = { magnitude: input.space_above_pt, unit: 'PT' };
    fields.push('spaceAbove');
  }
  if (input.space_below_pt !== undefined) {
    paragraphStyle.spaceBelow = { magnitude: input.space_below_pt, unit: 'PT' };
    fields.push('spaceBelow');
  }

  if (fields.length === 0) {
    throw new Error('No style attributes specified. Provide at least one of: named_style, alignment, indent_start_pt, indent_end_pt, line_spacing_pct, space_above_pt, space_below_pt.');
  }

  await docs.documents.batchUpdate({
    documentId: input.document_id,
    requestBody: {
      requests: [
        {
          updateParagraphStyle: {
            range: { startIndex, endIndex },
            paragraphStyle,
            fields: fields.join(','),
          },
        },
      ],
    },
  });

  return {
    document_id: input.document_id,
    matched_start_index: startIndex,
    matched_end_index: endIndex,
  };
}

// =========================================================================
// delete_paragraph
// =========================================================================

export const deleteParagraphSchema = z.object({
  document_id: z.string().min(1).describe('Google Docs document ID.'),
  paragraph_text: z.string().min(1).describe('Exact text of the paragraph to delete. Case-sensitive. First matching paragraph wins.'),
});

export type DeleteParagraphInput = z.infer<typeof deleteParagraphSchema>;

export async function deleteParagraph(input: DeleteParagraphInput): Promise<{
  document_id: string;
  deleted_start_index: number;
  deleted_end_index: number;
}> {
  const { docs } = await getGoogleClients();
  const doc = await docs.documents.get({ documentId: input.document_id });
  const body = doc.data.body;
  if (!body?.content) {
    throw new Error('Document body is empty or unreadable.');
  }

  let startIndex: number | null = null;
  let endIndex: number | null = null;
  for (const element of body.content) {
    if (!element.paragraph) continue;
    const elements: docs_v1.Schema$ParagraphElement[] = element.paragraph.elements ?? [];
    const paragraphText = elements
      .map((e: docs_v1.Schema$ParagraphElement) => e.textRun?.content ?? '')
      .join('')
      .replace(/\n$/, '');
    if (paragraphText === input.paragraph_text) {
      startIndex = element.startIndex ?? null;
      endIndex = element.endIndex ?? null;
      break;
    }
  }

  if (startIndex === null || endIndex === null) {
    throw new Error(`Paragraph not found: "${input.paragraph_text}". Verify exact text and case.`);
  }

  // endIndex is one past the trailing newline — deleting [startIndex, endIndex)
  // removes the paragraph and its terminating break, leaving no blank line behind.
  await docs.documents.batchUpdate({
    documentId: input.document_id,
    requestBody: {
      requests: [
        {
          deleteContentRange: {
            range: { startIndex, endIndex },
          },
        },
      ],
    },
  });

  return {
    document_id: input.document_id,
    deleted_start_index: startIndex,
    deleted_end_index: endIndex,
  };
}

// =========================================================================
// insert_table
// =========================================================================

export const insertTableSchema = z.object({
  document_id: z.string().min(1).describe('Google Docs document ID.'),
  anchor_text: z.string().min(1).describe('Exact text of an existing paragraph used as the insertion anchor.'),
  position: z.enum(['after', 'before']).default('after').describe("Insert the table immediately after (default) or before the anchor paragraph."),
  rows: z.number().int().min(1).max(100).describe('Number of rows in the new table.'),
  columns: z.number().int().min(1).max(20).describe('Number of columns in the new table.'),
});

export type InsertTableInput = z.infer<typeof insertTableSchema>;

export async function insertTable(input: InsertTableInput): Promise<{
  document_id: string;
  inserted_at_index: number;
  rows: number;
  columns: number;
}> {
  const { docs } = await getGoogleClients();
  const doc = await docs.documents.get({ documentId: input.document_id });
  const body = doc.data.body;
  if (!body?.content) {
    throw new Error('Document body is empty or unreadable.');
  }

  let foundStartIndex: number | null = null;
  let foundEndIndex: number | null = null;
  for (const element of body.content) {
    if (!element.paragraph) continue;
    const elements: docs_v1.Schema$ParagraphElement[] = element.paragraph.elements ?? [];
    const paragraphText = elements
      .map((e: docs_v1.Schema$ParagraphElement) => e.textRun?.content ?? '')
      .join('')
      .replace(/\n$/, '');
    if (paragraphText === input.anchor_text) {
      foundStartIndex = element.startIndex ?? null;
      foundEndIndex = element.endIndex ?? null;
      break;
    }
  }

  if (foundStartIndex === null || foundEndIndex === null) {
    throw new Error('Anchor paragraph not found: "' + input.anchor_text + '". Verify exact text and case.');
  }

  const insertIndex = input.position === 'after' ? foundEndIndex : foundStartIndex;

  await docs.documents.batchUpdate({
    documentId: input.document_id,
    requestBody: {
      requests: [
        {
          insertTable: {
            location: { index: insertIndex },
            rows: input.rows,
            columns: input.columns,
          },
        },
      ],
    },
  });

  return {
    document_id: input.document_id,
    inserted_at_index: insertIndex,
    rows: input.rows,
    columns: input.columns,
  };
}

// =========================================================================
// update_table_cell
// =========================================================================

export const updateTableCellSchema = z.object({
  document_id: z.string().min(1).describe('Google Docs document ID.'),
  table_index: z.number().int().min(0).describe('Zero-based index of the table in the document. The first table is 0.'),
  row: z.number().int().min(0).describe('Zero-based row index within the table.'),
  column: z.number().int().min(0).describe('Zero-based column index within the table.'),
  content: z.string().min(0).describe('Text to write into the cell. Replaces existing content.'),
});

export type UpdateTableCellInput = z.infer<typeof updateTableCellSchema>;

export async function updateTableCell(input: UpdateTableCellInput): Promise<{
  document_id: string;
  table_index: number;
  row: number;
  column: number;
  cell_start_index: number;
}> {
  const { docs } = await getGoogleClients();
  const doc = await docs.documents.get({ documentId: input.document_id });
  const body = doc.data.body;
  if (!body?.content) {
    throw new Error('Document body is empty or unreadable.');
  }

  // Walk content collecting tables in order.
  const tables: docs_v1.Schema$Table[] = [];
  for (const element of body.content) {
    if (element.table) tables.push(element.table);
  }
  const table = tables[input.table_index];
  if (!table) {
    throw new Error('Table index ' + input.table_index + ' not found. Document has ' + tables.length + ' tables.');
  }
  const tableRow = table.tableRows?.[input.row];
  if (!tableRow) {
    throw new Error('Row index ' + input.row + ' not found. Table has ' + (table.tableRows?.length ?? 0) + ' rows.');
  }
  const cell = tableRow.tableCells?.[input.column];
  if (!cell) {
    throw new Error('Column index ' + input.column + ' not found. Row has ' + (tableRow.tableCells?.length ?? 0) + ' columns.');
  }

  const cellStart = cell.startIndex ?? 0;
  const cellEnd = cell.endIndex ?? 0;
  const cellContentStart = cellStart + 1;
  const cellContentEnd = cellEnd - 1;

  const requests: docs_v1.Schema$Request[] = [];
  if (cellContentEnd > cellContentStart) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: cellContentStart, endIndex: cellContentEnd },
      },
    });
  }
  if (input.content.length > 0) {
    requests.push({
      insertText: {
        location: { index: cellContentStart },
        text: input.content,
      },
    });
  }

  if (requests.length > 0) {
    await docs.documents.batchUpdate({
      documentId: input.document_id,
      requestBody: { requests },
    });
  }

  return {
    document_id: input.document_id,
    table_index: input.table_index,
    row: input.row,
    column: input.column,
    cell_start_index: cellStart,
  };
}

// =========================================================================
// insert_image
// =========================================================================

export const insertImageSchema = z.object({
  document_id: z.string().min(1).describe('Google Docs document ID.'),
  anchor_text: z.string().min(1).describe('Exact text of an existing paragraph used as the insertion anchor.'),
  position: z.enum(['after', 'before']).default('after').describe('Insert the image immediately after (default) or before the anchor paragraph.'),
  image_url: z.string().url().describe('Publicly accessible URL of the image to embed. Must be reachable from Google servers.'),
  width_pt: z.number().min(1).max(2000).optional().describe('Optional explicit width in points. If omitted, Google uses the image native size.'),
  height_pt: z.number().min(1).max(2000).optional().describe('Optional explicit height in points. If omitted, Google uses the image native size.'),
});

export type InsertImageInput = z.infer<typeof insertImageSchema>;

export async function insertImage(input: InsertImageInput): Promise<{
  document_id: string;
  inserted_at_index: number;
}> {
  const { docs } = await getGoogleClients();
  const doc = await docs.documents.get({ documentId: input.document_id });
  const body = doc.data.body;
  if (!body?.content) {
    throw new Error('Document body is empty or unreadable.');
  }

  let foundStartIndex: number | null = null;
  let foundEndIndex: number | null = null;
  for (const element of body.content) {
    if (!element.paragraph) continue;
    const elements: docs_v1.Schema$ParagraphElement[] = element.paragraph.elements ?? [];
    const paragraphText = elements
      .map((e: docs_v1.Schema$ParagraphElement) => e.textRun?.content ?? '')
      .join('')
      .replace(/\n$/, '');
    if (paragraphText === input.anchor_text) {
      foundStartIndex = element.startIndex ?? null;
      foundEndIndex = element.endIndex ?? null;
      break;
    }
  }

  if (foundStartIndex === null || foundEndIndex === null) {
    throw new Error('Anchor paragraph not found: "' + input.anchor_text + '". Verify exact text and case.');
  }

  const insertIndex = input.position === 'after' ? foundEndIndex : foundStartIndex;

  const insertInlineImage: docs_v1.Schema$InsertInlineImageRequest = {
    location: { index: insertIndex },
    uri: input.image_url,
  };
  if (input.width_pt !== undefined || input.height_pt !== undefined) {
    insertInlineImage.objectSize = {};
    if (input.width_pt !== undefined) {
      insertInlineImage.objectSize.width = { magnitude: input.width_pt, unit: 'PT' };
    }
    if (input.height_pt !== undefined) {
      insertInlineImage.objectSize.height = { magnitude: input.height_pt, unit: 'PT' };
    }
  }

  await docs.documents.batchUpdate({
    documentId: input.document_id,
    requestBody: { requests: [{ insertInlineImage }] },
  });

  return {
    document_id: input.document_id,
    inserted_at_index: insertIndex,
  };
}

// =========================================================================
// apply_list_style
// =========================================================================

const bulletPresetEnum = z.enum([
  'BULLET_DISC_CIRCLE_SQUARE',
  'BULLET_DIAMONDX_ARROW3D_SQUARE',
  'BULLET_CHECKBOX',
  'BULLET_ARROW_DIAMOND_DISC',
  'BULLET_STAR_CIRCLE_SQUARE',
  'BULLET_ARROW3D_CIRCLE_SQUARE',
  'BULLET_LEFTTRIANGLE_DIAMOND_DISC',
  'BULLET_DIAMONDX_HOLLOWDIAMOND_SQUARE',
  'BULLET_DIAMOND_CIRCLE_SQUARE',
  'NUMBERED_DECIMAL_ALPHA_ROMAN',
  'NUMBERED_DECIMAL_ALPHA_ROMAN_PARENS',
  'NUMBERED_DECIMAL_NESTED',
  'NUMBERED_UPPERALPHA_ALPHA_ROMAN',
  'NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL',
  'NUMBERED_ZERODECIMAL_ALPHA_ROMAN',
]);

export const applyListStyleSchema = z.object({
  document_id: z.string().min(1).describe('Google Docs document ID.'),
  paragraph_text: z.string().min(1).describe('Exact text of an existing paragraph to promote to a list item. Case-sensitive.'),
  bullet_preset: bulletPresetEnum.default('BULLET_DISC_CIRCLE_SQUARE').describe('Bullet glyph preset. BULLET_* are unordered lists; NUMBERED_* are ordered. Default BULLET_DISC_CIRCLE_SQUARE (standard round bullet).'),
  remove: z.boolean().default(false).describe('If true, remove list bullets from the paragraph instead of applying them.'),
});

export type ApplyListStyleInput = z.infer<typeof applyListStyleSchema>;

export async function applyListStyle(input: ApplyListStyleInput): Promise<{
  document_id: string;
  matched_start_index: number;
  matched_end_index: number;
  action: 'applied' | 'removed';
}> {
  const { docs } = await getGoogleClients();
  const doc = await docs.documents.get({ documentId: input.document_id });
  const body = doc.data.body;
  if (!body?.content) {
    throw new Error('Document body is empty or unreadable.');
  }

  let startIndex: number | null = null;
  let endIndex: number | null = null;
  for (const element of body.content) {
    if (!element.paragraph) continue;
    const elements: docs_v1.Schema$ParagraphElement[] = element.paragraph.elements ?? [];
    const paragraphText = elements
      .map((e: docs_v1.Schema$ParagraphElement) => e.textRun?.content ?? '')
      .join('')
      .replace(/\n$/, '');
    if (paragraphText === input.paragraph_text) {
      startIndex = element.startIndex ?? null;
      endIndex = element.endIndex ?? null;
      break;
    }
  }

  if (startIndex === null || endIndex === null) {
    throw new Error('Paragraph not found: "' + input.paragraph_text + '". Verify exact text and case.');
  }

  const request: docs_v1.Schema$Request = input.remove
    ? { deleteParagraphBullets: { range: { startIndex, endIndex } } }
    : {
        createParagraphBullets: {
          range: { startIndex, endIndex },
          bulletPreset: input.bullet_preset,
        },
      };

  await docs.documents.batchUpdate({
    documentId: input.document_id,
    requestBody: { requests: [request] },
  });

  return {
    document_id: input.document_id,
    matched_start_index: startIndex,
    matched_end_index: endIndex,
    action: input.remove ? 'removed' : 'applied',
  };
}
