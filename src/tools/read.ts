/**
 * Read operations: get_document, get_spreadsheet, get_file_metadata.
 *
 * The single biggest-leverage tools in the v0.2.0 expansion. Without these,
 * the MCP can edit but can't see what's there — every cleanup operation
 * becomes a guess. With them, the AI can read structure, find the right
 * anchor, and write a surgical edit.
 *
 * Each tool is shaped to return enough information to drive subsequent
 * edits without dumping the entire raw API response. Indices are included
 * because they're cheap; style runs are opt-in because they bloat output.
 */

import { z } from 'zod';
import type { docs_v1, sheets_v4, drive_v3 } from 'googleapis';
import { getGoogleClients } from '../google.js';

// =========================================================================
// get_document
// =========================================================================

export const getDocumentSchema = z.object({
  document_id: z.string().min(1).describe('Google Docs document ID.'),
  include_style_runs: z
    .boolean()
    .default(false)
    .describe(
      "If true, returns per-character text style runs (bold/italic/font/color) per paragraph. Verbose; use only when you need to inspect inline styling. Default false returns paragraph-level style only.",
    ),
  max_paragraphs: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(2000)
    .describe('Cap on the number of paragraphs returned. Documents longer than this are truncated; `truncated: true` will be set in the response.'),
});

export type GetDocumentInput = z.infer<typeof getDocumentSchema>;

interface ParagraphSummary {
  /** Zero-based paragraph index in the body. */
  index: number;
  /** Plain text of the paragraph (no trailing newline). */
  text: string;
  /** Docs API startIndex (one-based-ish character offset). */
  startIndex: number;
  /** Docs API endIndex. */
  endIndex: number;
  /** Named paragraph style like HEADING_1, HEADING_2, NORMAL_TEXT, TITLE, SUBTITLE. */
  namedStyle?: string;
  /** Paragraph alignment: START, CENTER, END, JUSTIFIED. */
  alignment?: string;
  /** Bullet list info if this paragraph is part of a list. */
  bullet?: { listId: string; nestingLevel: number };
  /** Optional inline style runs — only present when include_style_runs=true. */
  runs?: Array<{
    text: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    foregroundHex?: string;
    fontSizePt?: number;
    fontFamily?: string;
    link?: string;
  }>;
}

export async function getDocument(input: GetDocumentInput): Promise<{
  document_id: string;
  title: string;
  total_paragraphs: number;
  returned_paragraphs: number;
  truncated: boolean;
  paragraphs: ParagraphSummary[];
}> {
  const { docs } = await getGoogleClients();

  const doc = await docs.documents.get({
    documentId: input.document_id,
  });

  const body = doc.data.body;
  const allElements = body?.content ?? [];

  // Collect all paragraph structural elements.
  const paragraphs: ParagraphSummary[] = [];
  let paragraphIndex = 0;

  for (const element of allElements) {
    if (!element.paragraph) continue;
    if (paragraphs.length >= input.max_paragraphs) break;

    const summary = summarizeParagraph(
      paragraphIndex,
      element,
      element.paragraph,
      input.include_style_runs,
    );
    paragraphs.push(summary);
    paragraphIndex++;
  }

  const totalParagraphs = allElements.filter((e) => !!e.paragraph).length;

  return {
    document_id: input.document_id,
    title: doc.data.title ?? '',
    total_paragraphs: totalParagraphs,
    returned_paragraphs: paragraphs.length,
    truncated: paragraphs.length < totalParagraphs,
    paragraphs,
  };
}

function summarizeParagraph(
  index: number,
  element: docs_v1.Schema$StructuralElement,
  paragraph: docs_v1.Schema$Paragraph,
  includeStyleRuns: boolean,
): ParagraphSummary {
  const elements: docs_v1.Schema$ParagraphElement[] = paragraph.elements ?? [];

  // Concatenate all text-run content into a single string. Strip the trailing
  // newline that paragraphs always carry — the caller wants the visible text.
  const rawText = elements
    .map((e: docs_v1.Schema$ParagraphElement) => e.textRun?.content ?? '')
    .join('');
  const text = rawText.replace(/\n$/, '');

  const summary: ParagraphSummary = {
    index,
    text,
    startIndex: element.startIndex ?? 0,
    endIndex: element.endIndex ?? 0,
  };

  const paragraphStyle = paragraph.paragraphStyle;
  if (paragraphStyle?.namedStyleType) {
    summary.namedStyle = paragraphStyle.namedStyleType;
  }
  if (paragraphStyle?.alignment) {
    summary.alignment = paragraphStyle.alignment;
  }

  if (paragraph.bullet) {
    summary.bullet = {
      listId: paragraph.bullet.listId ?? '',
      nestingLevel: paragraph.bullet.nestingLevel ?? 0,
    };
  }

  if (includeStyleRuns) {
    const runs: ParagraphSummary['runs'] = [];
    for (const e of elements) {
      const tr = e.textRun;
      if (!tr?.content) continue;
      const runText = tr.content.replace(/\n$/, '');
      if (!runText) continue;
      const style = tr.textStyle ?? {};
      const run: NonNullable<ParagraphSummary['runs']>[number] = { text: runText };
      if (style.bold) run.bold = true;
      if (style.italic) run.italic = true;
      if (style.underline) run.underline = true;
      if (style.strikethrough) run.strikethrough = true;
      const hex = rgbToHex(style.foregroundColor);
      if (hex) run.foregroundHex = hex;
      if (style.fontSize?.magnitude) run.fontSizePt = style.fontSize.magnitude;
      if (style.weightedFontFamily?.fontFamily) run.fontFamily = style.weightedFontFamily.fontFamily;
      if (style.link?.url) run.link = style.link.url;
      runs.push(run);
    }
    if (runs.length > 0) summary.runs = runs;
  }

  return summary;
}

function rgbToHex(color: docs_v1.Schema$OptionalColor | undefined | null): string | undefined {
  const rgb = color?.color?.rgbColor;
  if (!rgb) return undefined;
  const toHex = (n: number | undefined | null): string => {
    const v = Math.round((n ?? 0) * 255);
    return v.toString(16).padStart(2, '0');
  };
  return `#${toHex(rgb.red)}${toHex(rgb.green)}${toHex(rgb.blue)}`;
}

// =========================================================================
// get_spreadsheet
// =========================================================================

export const getSpreadsheetSchema = z.object({
  spreadsheet_id: z.string().min(1).describe('Google Sheets spreadsheet ID.'),
  include_values: z
    .boolean()
    .default(false)
    .describe('If true, returns cell values for each sheet (or for the range specified in `ranges`). Caps each sheet at 5000 rows × 50 columns to avoid huge responses.'),
  ranges: z
    .array(z.string().min(1))
    .optional()
    .describe('Optional list of A1-notation ranges to read values from (e.g., ["Sheet1!A1:D100"]). If omitted and include_values=true, reads the full grid of every sheet.'),
});

export type GetSpreadsheetInput = z.infer<typeof getSpreadsheetSchema>;

interface SheetSummary {
  sheet_id: number;
  title: string;
  index: number;
  row_count: number;
  column_count: number;
  frozen_rows?: number;
  frozen_columns?: number;
}

export async function getSpreadsheet(input: GetSpreadsheetInput): Promise<{
  spreadsheet_id: string;
  title: string;
  sheets: SheetSummary[];
  values?: Record<string, unknown[][]>;
}> {
  const { sheets } = await getGoogleClients();

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: input.spreadsheet_id,
    includeGridData: false,
  });

  const sheetSummaries: SheetSummary[] = (meta.data.sheets ?? []).map((s: sheets_v4.Schema$Sheet) => {
    const props = s.properties ?? {};
    const grid = props.gridProperties ?? {};
    const summary: SheetSummary = {
      sheet_id: props.sheetId ?? 0,
      title: props.title ?? '',
      index: props.index ?? 0,
      row_count: grid.rowCount ?? 0,
      column_count: grid.columnCount ?? 0,
    };
    if (grid.frozenRowCount) summary.frozen_rows = grid.frozenRowCount;
    if (grid.frozenColumnCount) summary.frozen_columns = grid.frozenColumnCount;
    return summary;
  });

  const result: {
    spreadsheet_id: string;
    title: string;
    sheets: SheetSummary[];
    values?: Record<string, unknown[][]>;
  } = {
    spreadsheet_id: input.spreadsheet_id,
    title: meta.data.properties?.title ?? '',
    sheets: sheetSummaries,
  };

  if (input.include_values) {
    const rangesToRead = input.ranges ?? sheetSummaries.map((s) => `'${s.title}'!A1:AX5000`);
    const valuesResponse = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: input.spreadsheet_id,
      ranges: rangesToRead,
    });
    const valuesByRange: Record<string, unknown[][]> = {};
    for (const v of valuesResponse.data.valueRanges ?? []) {
      if (v.range) valuesByRange[v.range] = (v.values as unknown[][]) ?? [];
    }
    result.values = valuesByRange;
  }

  return result;
}

// =========================================================================
// get_file_metadata
// =========================================================================

export const getFileMetadataSchema = z.object({
  file_id: z.string().min(1).describe('Drive file ID.'),
});

export type GetFileMetadataInput = z.infer<typeof getFileMetadataSchema>;

interface FileMetadata {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  webViewLink?: string;
  iconLink?: string;
  shared?: boolean;
  trashed?: boolean;
  version?: string;
  description?: string;
  starred?: boolean;
  capabilities?: Record<string, boolean>;
}

export async function getFileMetadata(input: GetFileMetadataInput): Promise<FileMetadata> {
  const { drive } = await getGoogleClients();

  const result = await drive.files.get({
    fileId: input.file_id,
    fields:
      'id, name, mimeType, parents, size, createdTime, modifiedTime, owners(displayName,emailAddress), webViewLink, iconLink, shared, trashed, version, description, starred, capabilities',
    supportsAllDrives: true,
  });

  const f: drive_v3.Schema$File = result.data;
  const out: FileMetadata = {
    id: f.id ?? input.file_id,
    name: f.name ?? '',
    mimeType: f.mimeType ?? '',
    parents: f.parents ?? [],
  };
  if (f.size) out.size = f.size;
  if (f.createdTime) out.createdTime = f.createdTime;
  if (f.modifiedTime) out.modifiedTime = f.modifiedTime;
  if (f.owners && f.owners.length > 0) {
    out.owners = f.owners.map((o) => ({
      ...(o.displayName ? { displayName: o.displayName } : {}),
      ...(o.emailAddress ? { emailAddress: o.emailAddress } : {}),
    }));
  }
  if (f.webViewLink) out.webViewLink = f.webViewLink;
  if (f.iconLink) out.iconLink = f.iconLink;
  if (typeof f.shared === 'boolean') out.shared = f.shared;
  if (typeof f.trashed === 'boolean') out.trashed = f.trashed;
  if (f.version) out.version = f.version;
  if (f.description) out.description = f.description;
  if (typeof f.starred === 'boolean') out.starred = f.starred;
  if (f.capabilities) {
    const caps: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(f.capabilities)) {
      if (typeof v === 'boolean') caps[k] = v;
    }
    out.capabilities = caps;
  }
  return out;
}
