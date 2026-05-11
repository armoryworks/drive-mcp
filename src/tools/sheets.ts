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
});

export type FindAndReplaceInSheetInput = z.infer<typeof findAndReplaceInSheetSchema>;

export async function findAndReplaceInSheet(input: FindAndReplaceInSheetInput): Promise<{
  spreadsheet_id: string;
  occurrences_changed: number;
  rows_changed: number;
  sheets_changed: number;
}> {
  const { sheets } = await getGoogleClients();

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
  };
}
