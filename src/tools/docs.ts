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
});

export type FindAndReplaceInput = z.infer<typeof findAndReplaceSchema>;

export async function findAndReplace(input: FindAndReplaceInput): Promise<{
  document_id: string;
  occurrences_changed: number;
}> {
  const { docs } = await getGoogleClients();

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
