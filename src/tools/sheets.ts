/**
 * Google Sheets operation tools.
 *
 * In-place sheet edits via the values.* and spreadsheets.batchUpdate endpoints.
 *
 * Tools provided:
 *   - append_row:               append a row to the bottom of a sheet
 *   - update_cell:              set a single cell's value
 *   - update_range:             set a 2D range of values
 *   - find_and_replace_in_sheet: sheet-wide find-and-replace
 */

import { z } from 'zod';
import { getGoogleClients } from '../google.js';
import { log } from '../lib/retry.js';

// Sheets API accepts cell values as strings, numbers, or booleans. We
// preserve the original type so e.g. dollar amounts stay numeric.
const cellValueSchema = z.union([z.string(), z.number(), z.boolean()]);

// =========================================================================
// append_row
// =========================================================================

export const appendRowSchema = z.object({
  spreadsheet_id: z.string().min(1).describe('Google Sheets spreadsheet ID.'),
  sheet_name: z
    .string()
    .min(1)
    .describe('Name of the tab to append to (e.g., "Sheet1"). The first tab is usually "Sheet1".'),
  values: z
    .array(cellValueSchema)
    .min(1)
    .describe('Row values, left to right. Strings, numbers, and booleans are supported.'),
  value_input_option: z
    .enum(['USER_ENTERED', 'RAW'])
    .default('USER_ENTERED')
    .describe(
      "USER_ENTERED (default) parses values as a human would (e.g., '=SUM(A1:A10)' becomes a formula). RAW stores the literal string.",
    ),
});

export type AppendRowInput = z.infer<typeof appendRowSchema>;

export async function appendRow(input: AppendRowInput): Promise<{
  spreadsheet_id: string;
  updated_range: string;
  updated_rows: number;
}> {
  const { sheets } = await getGoogleClients();

  const result = await sheets.spreadsheets.values.append({
    spreadsheetId: input.spreadsheet_id,
    range: input.sheet_name,
    valueInputOption: input.value_input_option,
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [input.values],
    },
  });

  return {
    spreadsheet_id: input.spreadsheet_id,
    updated_range: result.data.updates?.updatedRange ?? '',
    updated_rows: result.data.updates?.updatedRows ?? 1,
  };
}

// =========================================================================
// update_cell
// =========================================================================

export const updateCellSchema = z.object({
  spreadsheet_id: z.string().min(1).describe('Google Sheets spreadsheet ID.'),
  range: z
    .string()
    .min(1)
    .describe(
      "Cell in A1 notation, e.g., 'Sheet1!B7' or 'Pre-funding Expense Report!D14'. Must reference a single cell.",
    ),
  value: cellValueSchema.describe('New cell value. String, number, or boolean.'),
  value_input_option: z
    .enum(['USER_ENTERED', 'RAW'])
    .default('USER_ENTERED')
    .describe(
      "USER_ENTERED (default) parses '=SUM(A1:A10)' as a formula. RAW stores the literal string.",
    ),
});

export type UpdateCellInput = z.infer<typeof updateCellSchema>;

export async function updateCell(input: UpdateCellInput): Promise<{
  spreadsheet_id: string;
  updated_range: string;
}> {
  const { sheets } = await getGoogleClients();

  const result = await sheets.spreadsheets.values.update({
    spreadsheetId: input.spreadsheet_id,
    range: input.range,
    valueInputOption: input.value_input_option,
    requestBody: {
      values: [[input.value]],
    },
  });

  return {
    spreadsheet_id: input.spreadsheet_id,
    updated_range: result.data.updatedRange ?? input.range,
  };
}

// =========================================================================
// update_range
// =========================================================================

export const updateRangeSchema = z.object({
  spreadsheet_id: z.string().min(1).describe('Google Sheets spreadsheet ID.'),
  range: z
    .string()
    .min(1)
    .describe("Range in A1 notation, e.g., 'Sheet1!A1:C10'."),
  values: z
    .array(z.array(cellValueSchema))
    .min(1)
    .describe(
      'Outer array is rows; inner arrays are cells left-to-right. All rows should have the same length.',
    ),
  value_input_option: z
    .enum(['USER_ENTERED', 'RAW'])
    .default('USER_ENTERED')
    .describe('USER_ENTERED parses formulas; RAW stores literal strings.'),
});

export type UpdateRangeInput = z.infer<typeof updateRangeSchema>;

export async function updateRange(input: UpdateRangeInput): Promise<{
  spreadsheet_id: string;
  updated_range: string;
  updated_rows: number;
  updated_columns: number;
  updated_cells: number;
}> {
  const { sheets } = await getGoogleClients();

  const result = await sheets.spreadsheets.values.update({
    spreadsheetId: input.spreadsheet_id,
    range: input.range,
    valueInputOption: input.value_input_option,
    requestBody: {
      values: input.values,
    },
  });

  return {
    spreadsheet_id: input.spreadsheet_id,
    updated_range: result.data.updatedRange ?? input.range,
    updated_rows: result.data.updatedRows ?? 0,
    updated_columns: result.data.updatedColumns ?? 0,
    updated_cells: result.data.updatedCells ?? 0,
  };
}

// =========================================================================
// find_and_replace_in_sheet
// =========================================================================

export const findAndReplaceInSheetSchema = z.object({
  spreadsheet_id: z.string().min(1).describe('Google Sheets spreadsheet ID.'),
  find: z.string().min(1).describe('Text to search for.'),
  replace: z.string().describe('Replacement text. May be empty string.'),
  sheet_id: z
    .number()
    .int()
    .optional()
    .describe(
      'If set, restricts the search to a single sheet/tab (numeric sheet ID, not the tab name). Omit to search all sheets in the spreadsheet.',
    ),
  match_case: z.boolean().default(false).describe('If true, the search is case-sensitive.'),
  match_entire_cell: z
    .boolean()
    .default(false)
    .describe('If true, only matches when the entire cell content equals the find text.'),
  dry_run: z.boolean().default(false).describe('If true, counts occurrences via a scan but does not modify any cell. Use to preview a large find-and-replace before committing.'),
});

export type FindAndReplaceInSheetInput = z.infer<typeof findAndReplaceInSheetSchema>;

export async function findAndReplaceInSheet(input: FindAndReplaceInSheetInput): Promise<{
  spreadsheet_id: string;
  occurrences_changed: number;
  rows_changed: number;
  sheets_changed: number;
  dry_run: boolean;
}> {
  const { sheets } = await getGoogleClients();

  if (input.dry_run) {
    // Scan values to count what WOULD match without modifying anything.
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: input.spreadsheet_id, includeGridData: false,
    });
    const targetSheets = (meta.data.sheets ?? []).filter((s) => {
      if (input.sheet_id === undefined) return true;
      return s.properties?.sheetId === input.sheet_id;
    });
    const ranges = targetSheets.map((s) => "'" + (s.properties?.title ?? '') + "'!A1:AX5000");
    const valuesResp = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: input.spreadsheet_id, ranges,
    });
    let occurrences = 0;
    const rowsTouched = new Set<string>();
    const sheetsTouched = new Set<string>();
    const needle = input.match_case ? input.find : input.find.toLowerCase();
    for (const vr of valuesResp.data.valueRanges ?? []) {
      const sheetTitle = (vr.range ?? '').split('!')[0] ?? '';
      const rows = (vr.values ?? []) as unknown[][];
      for (let r = 0; r < rows.length; r++) {
        for (const cell of rows[r] ?? []) {
          const cellStr = String(cell ?? '');
          const haystack = input.match_case ? cellStr : cellStr.toLowerCase();
          let count = 0;
          if (input.match_entire_cell) {
            if (haystack === needle) count = 1;
          } else {
            let idx = 0;
            while ((idx = haystack.indexOf(needle, idx)) !== -1) {
              count++;
              idx += needle.length;
            }
          }
          if (count > 0) {
            occurrences += count;
            rowsTouched.add(sheetTitle + ':' + r);
            sheetsTouched.add(sheetTitle);
          }
        }
      }
    }
    return {
      spreadsheet_id: input.spreadsheet_id,
      occurrences_changed: occurrences,
      rows_changed: rowsTouched.size,
      sheets_changed: sheetsTouched.size,
      dry_run: true,
    };
  }

  log('info', 'destructive_op', { tool: 'find_and_replace_in_sheet', spreadsheet_id: input.spreadsheet_id, find_length: input.find.length });

  const findReplaceRequest: Record<string, unknown> = {
    find: input.find,
    replacement: input.replace,
    matchCase: input.match_case,
    matchEntireCell: input.match_entire_cell,
    includeFormulas: false,
  };
  if (input.sheet_id !== undefined) {
    findReplaceRequest['sheetId'] = input.sheet_id;
  } else {
    findReplaceRequest['allSheets'] = true;
  }

  const result = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: input.spreadsheet_id,
    requestBody: {
      requests: [
        { findReplace: findReplaceRequest as never },
      ],
    },
  });

  const reply = result.data.replies?.[0]?.findReplace;

  return {
    spreadsheet_id: input.spreadsheet_id,
    occurrences_changed: reply?.occurrencesChanged ?? 0,
    rows_changed: reply?.rowsChanged ?? 0,
    sheets_changed: reply?.sheetsChanged ?? 0,
    dry_run: false,
  };
}

// =========================================================================
// add_sheet
// =========================================================================

export const addSheetSchema = z.object({
  spreadsheet_id: z.string().min(1).describe('Google Sheets spreadsheet ID.'),
  title: z.string().min(1).describe('Name of the new sheet tab.'),
  index: z.number().int().min(0).optional().describe('Optional zero-based position in the tab list. If omitted, appends at the end.'),
  row_count: z.number().int().min(1).max(10000000).default(1000).describe('Initial row count. Default 1000.'),
  column_count: z.number().int().min(1).max(18278).default(26).describe('Initial column count. Default 26 (A-Z).'),
});

export type AddSheetInput = z.infer<typeof addSheetSchema>;

export async function addSheet(input: AddSheetInput): Promise<{
  spreadsheet_id: string;
  sheet_id: number;
  title: string;
  index: number;
}> {
  const { sheets } = await getGoogleClients();
  const result = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: input.spreadsheet_id,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: input.title,
              ...(input.index !== undefined ? { index: input.index } : {}),
              gridProperties: {
                rowCount: input.row_count,
                columnCount: input.column_count,
              },
            },
          },
        },
      ],
    },
  });

  const props = result.data.replies?.[0]?.addSheet?.properties;
  return {
    spreadsheet_id: input.spreadsheet_id,
    sheet_id: props?.sheetId ?? 0,
    title: props?.title ?? input.title,
    index: props?.index ?? 0,
  };
}

// =========================================================================
// delete_sheet
// =========================================================================

export const deleteSheetSchema = z.object({
  spreadsheet_id: z.string().min(1).describe('Google Sheets spreadsheet ID.'),
  sheet_id: z.number().int().describe('Numeric sheet ID (not the title). Use get_spreadsheet to look up.'),
});

export type DeleteSheetInput = z.infer<typeof deleteSheetSchema>;

export async function deleteSheet(input: DeleteSheetInput): Promise<{
  spreadsheet_id: string;
  sheet_id: number;
  deleted: true;
}> {
  const { sheets } = await getGoogleClients();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: input.spreadsheet_id,
    requestBody: {
      requests: [{ deleteSheet: { sheetId: input.sheet_id } }],
    },
  });
  return {
    spreadsheet_id: input.spreadsheet_id,
    sheet_id: input.sheet_id,
    deleted: true,
  };
}

// =========================================================================
// rename_sheet
// =========================================================================

export const renameSheetSchema = z.object({
  spreadsheet_id: z.string().min(1).describe('Google Sheets spreadsheet ID.'),
  sheet_id: z.number().int().describe('Numeric sheet ID (not the title). Use get_spreadsheet to look up.'),
  new_title: z.string().min(1).describe('New title for the sheet tab.'),
});

export type RenameSheetInput = z.infer<typeof renameSheetSchema>;

export async function renameSheet(input: RenameSheetInput): Promise<{
  spreadsheet_id: string;
  sheet_id: number;
  new_title: string;
}> {
  const { sheets } = await getGoogleClients();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: input.spreadsheet_id,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId: input.sheet_id, title: input.new_title },
            fields: 'title',
          },
        },
      ],
    },
  });
  return {
    spreadsheet_id: input.spreadsheet_id,
    sheet_id: input.sheet_id,
    new_title: input.new_title,
  };
}

// =========================================================================
// format_range
// =========================================================================

export const formatRangeSchema = z.object({
  spreadsheet_id: z.string().min(1).describe('Google Sheets spreadsheet ID.'),
  sheet_id: z.number().int().describe('Numeric sheet ID. Use get_spreadsheet to look up.'),
  start_row: z.number().int().min(0).describe('Zero-based start row index (inclusive).'),
  end_row: z.number().int().min(1).describe('Zero-based end row index (exclusive). To format only row 0, pass start_row=0, end_row=1.'),
  start_column: z.number().int().min(0).describe('Zero-based start column index (inclusive).'),
  end_column: z.number().int().min(1).describe('Zero-based end column index (exclusive).'),
  bold: z.boolean().optional().describe('Bold cell text.'),
  italic: z.boolean().optional().describe('Italic cell text.'),
  underline: z.boolean().optional().describe('Underline cell text.'),
  font_size_pt: z.number().min(1).max(400).optional().describe('Font size in points.'),
  font_family: z.string().optional().describe('Font family (e.g., "Arial", "Roboto Mono").'),
  foreground_hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Text color hex like "#1a73e8".'),
  background_hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Cell background color hex.'),
  horizontal_align: z.enum(['LEFT', 'CENTER', 'RIGHT']).optional().describe('Horizontal text alignment.'),
  vertical_align: z.enum(['TOP', 'MIDDLE', 'BOTTOM']).optional().describe('Vertical text alignment.'),
  number_format_pattern: z.string().optional().describe('Number format pattern (e.g., "#,##0.00", "$#,##0.00;[Red]-$#,##0.00", "yyyy-mm-dd"). See Sheets API NumberFormat docs.'),
  number_format_type: z.enum(['TEXT', 'NUMBER', 'PERCENT', 'CURRENCY', 'DATE', 'TIME', 'DATE_TIME', 'SCIENTIFIC']).optional().describe('Number format type. Pair with number_format_pattern for full control.'),
  wrap_text: z.boolean().optional().describe('Wrap long text within the cell.'),
});

export type FormatRangeInput = z.infer<typeof formatRangeSchema>;

export async function formatRange(input: FormatRangeInput): Promise<{
  spreadsheet_id: string;
  formatted_cells: number;
}> {
  const { sheets } = await getGoogleClients();

  interface CellFormatPayload {
    textFormat?: Record<string, unknown>;
    backgroundColor?: { red: number; green: number; blue: number };
    horizontalAlignment?: string;
    verticalAlignment?: string;
    numberFormat?: { type?: string; pattern?: string };
    wrapStrategy?: string;
  }

  const userEnteredFormat: CellFormatPayload = {};
  const fields: string[] = [];

  const textFormat: Record<string, unknown> = {};
  if (input.bold !== undefined) textFormat['bold'] = input.bold;
  if (input.italic !== undefined) textFormat['italic'] = input.italic;
  if (input.underline !== undefined) textFormat['underline'] = input.underline;
  if (input.font_size_pt !== undefined) textFormat['fontSize'] = input.font_size_pt;
  if (input.font_family !== undefined) textFormat['fontFamily'] = input.font_family;
  if (input.foreground_hex !== undefined) {
    textFormat['foregroundColor'] = hexToRgb(input.foreground_hex);
  }
  if (Object.keys(textFormat).length > 0) {
    userEnteredFormat.textFormat = textFormat;
    fields.push('userEnteredFormat.textFormat');
  }

  if (input.background_hex !== undefined) {
    userEnteredFormat.backgroundColor = hexToRgb(input.background_hex);
    fields.push('userEnteredFormat.backgroundColor');
  }
  if (input.horizontal_align !== undefined) {
    userEnteredFormat.horizontalAlignment = input.horizontal_align;
    fields.push('userEnteredFormat.horizontalAlignment');
  }
  if (input.vertical_align !== undefined) {
    userEnteredFormat.verticalAlignment = input.vertical_align;
    fields.push('userEnteredFormat.verticalAlignment');
  }
  if (input.number_format_pattern !== undefined || input.number_format_type !== undefined) {
    userEnteredFormat.numberFormat = {};
    if (input.number_format_type) userEnteredFormat.numberFormat.type = input.number_format_type;
    if (input.number_format_pattern) userEnteredFormat.numberFormat.pattern = input.number_format_pattern;
    fields.push('userEnteredFormat.numberFormat');
  }
  if (input.wrap_text !== undefined) {
    userEnteredFormat.wrapStrategy = input.wrap_text ? 'WRAP' : 'OVERFLOW_CELL';
    fields.push('userEnteredFormat.wrapStrategy');
  }

  if (fields.length === 0) {
    throw new Error('No formatting attributes specified. Provide at least one of: bold, italic, underline, font_size_pt, font_family, foreground_hex, background_hex, horizontal_align, vertical_align, number_format_pattern, wrap_text.');
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: input.spreadsheet_id,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: input.sheet_id,
              startRowIndex: input.start_row,
              endRowIndex: input.end_row,
              startColumnIndex: input.start_column,
              endColumnIndex: input.end_column,
            },
            cell: { userEnteredFormat: userEnteredFormat as Record<string, unknown> },
            fields: fields.join(','),
          },
        },
      ],
    },
  });

  const formattedCells =
    (input.end_row - input.start_row) * (input.end_column - input.start_column);
  return {
    spreadsheet_id: input.spreadsheet_id,
    formatted_cells: formattedCells,
  };
}

function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  const stripped = hex.startsWith('#') ? hex.slice(1) : hex;
  return {
    red: parseInt(stripped.slice(0, 2), 16) / 255,
    green: parseInt(stripped.slice(2, 4), 16) / 255,
    blue: parseInt(stripped.slice(4, 6), 16) / 255,
  };
}

// =========================================================================
// delete_rows / delete_columns / insert_rows / insert_columns
// =========================================================================

const dimensionEnum = z.enum(['ROWS', 'COLUMNS']);

export const deleteRowsSchema = z.object({
  spreadsheet_id: z.string().min(1).describe('Google Sheets spreadsheet ID.'),
  sheet_id: z.number().int().describe('Numeric sheet ID.'),
  start_index: z.number().int().min(0).describe('Zero-based start row index (inclusive).'),
  end_index: z.number().int().min(1).describe('Zero-based end row index (exclusive).'),
});

export type DeleteRowsInput = z.infer<typeof deleteRowsSchema>;

export async function deleteRows(input: DeleteRowsInput): Promise<{
  spreadsheet_id: string;
  deleted_count: number;
}> {
  return deleteDimension(input, 'ROWS');
}

export const deleteColumnsSchema = z.object({
  spreadsheet_id: z.string().min(1).describe('Google Sheets spreadsheet ID.'),
  sheet_id: z.number().int().describe('Numeric sheet ID.'),
  start_index: z.number().int().min(0).describe('Zero-based start column index (inclusive).'),
  end_index: z.number().int().min(1).describe('Zero-based end column index (exclusive).'),
});

export type DeleteColumnsInput = z.infer<typeof deleteColumnsSchema>;

export async function deleteColumns(input: DeleteColumnsInput): Promise<{
  spreadsheet_id: string;
  deleted_count: number;
}> {
  return deleteDimension(input, 'COLUMNS');
}

async function deleteDimension(
  input: { spreadsheet_id: string; sheet_id: number; start_index: number; end_index: number },
  dimension: z.infer<typeof dimensionEnum>,
): Promise<{ spreadsheet_id: string; deleted_count: number }> {
  const { sheets } = await getGoogleClients();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: input.spreadsheet_id,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: input.sheet_id,
              dimension,
              startIndex: input.start_index,
              endIndex: input.end_index,
            },
          },
        },
      ],
    },
  });
  return {
    spreadsheet_id: input.spreadsheet_id,
    deleted_count: input.end_index - input.start_index,
  };
}

export const insertRowsSchema = z.object({
  spreadsheet_id: z.string().min(1).describe('Google Sheets spreadsheet ID.'),
  sheet_id: z.number().int().describe('Numeric sheet ID.'),
  start_index: z.number().int().min(0).describe('Zero-based row index where new rows begin.'),
  end_index: z.number().int().min(1).describe('Zero-based row index where new rows end (exclusive). end_index - start_index = number of rows inserted.'),
  inherit_from_before: z.boolean().default(true).describe('If true, new rows inherit formatting from the row immediately above.'),
});

export type InsertRowsInput = z.infer<typeof insertRowsSchema>;

export async function insertRows(input: InsertRowsInput): Promise<{
  spreadsheet_id: string;
  inserted_count: number;
}> {
  return insertDimension(input, 'ROWS');
}

export const insertColumnsSchema = z.object({
  spreadsheet_id: z.string().min(1).describe('Google Sheets spreadsheet ID.'),
  sheet_id: z.number().int().describe('Numeric sheet ID.'),
  start_index: z.number().int().min(0).describe('Zero-based column index where new columns begin.'),
  end_index: z.number().int().min(1).describe('Zero-based column index where new columns end (exclusive).'),
  inherit_from_before: z.boolean().default(true).describe('If true, new columns inherit formatting from the column immediately to the left.'),
});

export type InsertColumnsInput = z.infer<typeof insertColumnsSchema>;

export async function insertColumns(input: InsertColumnsInput): Promise<{
  spreadsheet_id: string;
  inserted_count: number;
}> {
  return insertDimension(input, 'COLUMNS');
}

async function insertDimension(
  input: { spreadsheet_id: string; sheet_id: number; start_index: number; end_index: number; inherit_from_before: boolean },
  dimension: z.infer<typeof dimensionEnum>,
): Promise<{ spreadsheet_id: string; inserted_count: number }> {
  const { sheets } = await getGoogleClients();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: input.spreadsheet_id,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId: input.sheet_id,
              dimension,
              startIndex: input.start_index,
              endIndex: input.end_index,
            },
            inheritFromBefore: input.inherit_from_before,
          },
        },
      ],
    },
  });
  return {
    spreadsheet_id: input.spreadsheet_id,
    inserted_count: input.end_index - input.start_index,
  };
}

// =========================================================================
// create_chart
// =========================================================================

const chartTypeEnum = z.enum(['COLUMN', 'BAR', 'LINE', 'AREA', 'PIE', 'SCATTER', 'COMBO', 'HISTOGRAM']);

export const createChartSchema = z.object({
  spreadsheet_id: z.string().min(1).describe('Google Sheets spreadsheet ID.'),
  source_sheet_id: z.number().int().describe('Numeric sheet ID containing the data range.'),
  data_start_row: z.number().int().min(0).describe('Zero-based start row of the data range (inclusive). Include header row if you want labels.'),
  data_end_row: z.number().int().min(1).describe('Zero-based end row of the data range (exclusive).'),
  data_start_column: z.number().int().min(0).describe('Zero-based start column of the data range (inclusive).'),
  data_end_column: z.number().int().min(1).describe('Zero-based end column of the data range (exclusive).'),
  chart_type: chartTypeEnum.default('COLUMN').describe('Chart type. COLUMN (vertical bars, default), BAR (horizontal bars), LINE, AREA, PIE, SCATTER, COMBO, HISTOGRAM.'),
  title: z.string().optional().describe('Optional chart title.'),
  has_headers: z.boolean().default(true).describe('If true (default), treats the first row of the data range as series labels.'),
  target_sheet_id: z.number().int().optional().describe('Sheet ID to place the chart in. Defaults to source_sheet_id.'),
  target_anchor_row: z.number().int().min(0).default(0).describe('Top-left row of the chart placement.'),
  target_anchor_column: z.number().int().min(0).default(5).describe('Top-left column of the chart placement.'),
});

export type CreateChartInput = z.infer<typeof createChartSchema>;

export async function createChart(input: CreateChartInput): Promise<{
  spreadsheet_id: string;
  chart_id: number;
}> {
  const { sheets } = await getGoogleClients();

  const targetSheetId = input.target_sheet_id ?? input.source_sheet_id;

  const result = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: input.spreadsheet_id,
    requestBody: {
      requests: [
        {
          addChart: {
            chart: {
              spec: {
                ...(input.title ? { title: input.title } : {}),
                basicChart: {
                  chartType: input.chart_type,
                  legendPosition: 'BOTTOM_LEGEND',
                  headerCount: input.has_headers ? 1 : 0,
                  domains: [
                    {
                      domain: {
                        sourceRange: {
                          sources: [
                            {
                              sheetId: input.source_sheet_id,
                              startRowIndex: input.data_start_row,
                              endRowIndex: input.data_end_row,
                              startColumnIndex: input.data_start_column,
                              endColumnIndex: input.data_start_column + 1,
                            },
                          ],
                        },
                      },
                    },
                  ],
                  series: [
                    {
                      series: {
                        sourceRange: {
                          sources: [
                            {
                              sheetId: input.source_sheet_id,
                              startRowIndex: input.data_start_row,
                              endRowIndex: input.data_end_row,
                              startColumnIndex: input.data_start_column + 1,
                              endColumnIndex: input.data_end_column,
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
              },
              position: {
                overlayPosition: {
                  anchorCell: {
                    sheetId: targetSheetId,
                    rowIndex: input.target_anchor_row,
                    columnIndex: input.target_anchor_column,
                  },
                },
              },
            },
          },
        },
      ],
    },
  });

  const chartId = result.data.replies?.[0]?.addChart?.chart?.chartId ?? 0;
  return {
    spreadsheet_id: input.spreadsheet_id,
    chart_id: chartId,
  };
}

// =========================================================================
// add_data_validation
// =========================================================================

const validationConditionEnum = z.enum([
  'NUMBER_GREATER',
  'NUMBER_GREATER_THAN_EQ',
  'NUMBER_LESS',
  'NUMBER_LESS_THAN_EQ',
  'NUMBER_EQ',
  'NUMBER_NOT_EQ',
  'NUMBER_BETWEEN',
  'NUMBER_NOT_BETWEEN',
  'TEXT_CONTAINS',
  'TEXT_NOT_CONTAINS',
  'TEXT_STARTS_WITH',
  'TEXT_ENDS_WITH',
  'TEXT_EQ',
  'TEXT_IS_EMAIL',
  'TEXT_IS_URL',
  'DATE_EQ',
  'DATE_BEFORE',
  'DATE_AFTER',
  'DATE_ON_OR_BEFORE',
  'DATE_ON_OR_AFTER',
  'DATE_BETWEEN',
  'ONE_OF_RANGE',
  'ONE_OF_LIST',
  'BLANK',
  'NOT_BLANK',
  'CUSTOM_FORMULA',
  'BOOLEAN',
]);

export const addDataValidationSchema = z.object({
  spreadsheet_id: z.string().min(1).describe('Google Sheets spreadsheet ID.'),
  sheet_id: z.number().int().describe('Numeric sheet ID.'),
  start_row: z.number().int().min(0).describe('Zero-based start row (inclusive).'),
  end_row: z.number().int().min(1).describe('Zero-based end row (exclusive).'),
  start_column: z.number().int().min(0).describe('Zero-based start column (inclusive).'),
  end_column: z.number().int().min(1).describe('Zero-based end column (exclusive).'),
  condition_type: validationConditionEnum.describe('Validation condition type. Common: ONE_OF_LIST (dropdown), NUMBER_BETWEEN, DATE_AFTER, TEXT_IS_EMAIL, BOOLEAN (checkbox), CUSTOM_FORMULA.'),
  condition_values: z.array(z.string()).default([]).describe('Values for the condition. For ONE_OF_LIST, the dropdown options. For NUMBER_BETWEEN, [min, max]. For CUSTOM_FORMULA, single formula string.'),
  strict: z.boolean().default(true).describe('If true (default), reject invalid input. If false, show a warning but allow.'),
  show_custom_ui: z.boolean().default(true).describe('If true and the condition is ONE_OF_LIST or ONE_OF_RANGE, show a dropdown UI.'),
  input_message: z.string().optional().describe('Tooltip message shown when the cell is selected.'),
});

export type AddDataValidationInput = z.infer<typeof addDataValidationSchema>;

export async function addDataValidation(input: AddDataValidationInput): Promise<{
  spreadsheet_id: string;
  validated_cells: number;
}> {
  const { sheets } = await getGoogleClients();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: input.spreadsheet_id,
    requestBody: {
      requests: [
        {
          setDataValidation: {
            range: {
              sheetId: input.sheet_id,
              startRowIndex: input.start_row,
              endRowIndex: input.end_row,
              startColumnIndex: input.start_column,
              endColumnIndex: input.end_column,
            },
            rule: {
              condition: {
                type: input.condition_type,
                values: input.condition_values.map((v) => ({ userEnteredValue: v })),
              },
              strict: input.strict,
              showCustomUi: input.show_custom_ui,
              ...(input.input_message ? { inputMessage: input.input_message } : {}),
            },
          },
        },
      ],
    },
  });
  return {
    spreadsheet_id: input.spreadsheet_id,
    validated_cells: (input.end_row - input.start_row) * (input.end_column - input.start_column),
  };
}
