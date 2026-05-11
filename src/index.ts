#!/usr/bin/env node
/**
 * Armory Works Drive MCP — server entry point.
 *
 * Speaks MCP over stdio. The MCP host (Claude Desktop or another compatible
 * client) spawns this as a subprocess and communicates via JSON-RPC on
 * stdin/stdout. Tools are exposed via the standard ListTools / CallTool
 * request handlers.
 *
 * v0.2.0 inventory (~36 tools):
 *   Read:    get_document, get_spreadsheet, get_file_metadata
 *   Drive:   move_file, rename_file, delete_file, restore_file, list_folder,
 *            create_folder, create_doc, create_sheet, copy_file, search_files
 *   Docs:    find_and_replace, append_to_doc, insert_at_heading, apply_text_style,
 *            apply_paragraph_style, delete_paragraph, insert_table,
 *            update_table_cell, insert_image, apply_list_style
 *   Sheets:  append_row, update_cell, update_range, find_and_replace_in_sheet,
 *            add_sheet, delete_sheet, rename_sheet, format_range,
 *            delete_rows, delete_columns, insert_rows, insert_columns,
 *            create_chart, add_data_validation
 *   Perms:   share_file, list_permissions, revoke_permission, create_share_link
 *   Batch:   batch_doc_update, batch_sheet_update, batch_move, batch_delete
 *   Review:  add_comment, list_comments, resolve_comment,
 *            accept_all_suggestions, reject_all_suggestions
 *   Export:  export_to_pdf, export_to_docx, export_to_xlsx, get_thumbnail
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';

import { wrapToolErrors } from './lib/errors.js';
import { withRetry, log } from './lib/retry.js';
import { hasValidAuth } from './auth.js';

import {
  moveFile, moveFileSchema,
  renameFile, renameFileSchema,
  deleteFile, deleteFileSchema,
  restoreFile, restoreFileSchema,
  listFolder, listFolderSchema,
  createFolder, createFolderSchema,
  createDoc, createDocSchema,
  createSheet, createSheetSchema,
  copyFile, copyFileSchema,
  searchFiles, searchFilesSchema,
} from './tools/drive.js';

import {
  findAndReplace, findAndReplaceSchema,
  appendToDoc, appendToDocSchema,
  insertAtHeading, insertAtHeadingSchema,
  applyTextStyle, applyTextStyleSchema,
  applyParagraphStyle, applyParagraphStyleSchema,
  deleteParagraph, deleteParagraphSchema,
  insertTable, insertTableSchema,
  updateTableCell, updateTableCellSchema,
  insertImage, insertImageSchema,
  applyListStyle, applyListStyleSchema,
} from './tools/docs.js';

import {
  appendRow, appendRowSchema,
  updateCell, updateCellSchema,
  updateRange, updateRangeSchema,
  findAndReplaceInSheet, findAndReplaceInSheetSchema,
  addSheet, addSheetSchema,
  deleteSheet, deleteSheetSchema,
  renameSheet, renameSheetSchema,
  formatRange, formatRangeSchema,
  deleteRows, deleteRowsSchema,
  deleteColumns, deleteColumnsSchema,
  insertRows, insertRowsSchema,
  insertColumns, insertColumnsSchema,
  createChart, createChartSchema,
  addDataValidation, addDataValidationSchema,
} from './tools/sheets.js';

import {
  getDocument, getDocumentSchema,
  getSpreadsheet, getSpreadsheetSchema,
  getFileMetadata, getFileMetadataSchema,
} from './tools/read.js';

import {
  shareFile, shareFileSchema,
  listPermissions, listPermissionsSchema,
  revokePermission, revokePermissionSchema,
  createShareLink, createShareLinkSchema,
} from './tools/permissions.js';

import {
  batchDocUpdate, batchDocUpdateSchema,
  batchSheetUpdate, batchSheetUpdateSchema,
  batchMove, batchMoveSchema,
  batchDelete, batchDeleteSchema,
} from './tools/batch.js';

import {
  addComment, addCommentSchema,
  listComments, listCommentsSchema,
  resolveComment, resolveCommentSchema,
  acceptAllSuggestions, acceptAllSuggestionsSchema,
  rejectAllSuggestions, rejectAllSuggestionsSchema,
} from './tools/comments.js';

import {
  exportToPdf, exportToPdfSchema,
  exportToDocx, exportToDocxSchema,
  exportToXlsx, exportToXlsxSchema,
  getThumbnail, getThumbnailSchema,
} from './tools/exports.js';

interface ToolDef<T extends z.ZodType> {
  name: string;
  description: string;
  schema: T;
  handler: (input: z.infer<T>) => Promise<unknown>;
}

function tool<T extends z.ZodType>(def: ToolDef<T>): ToolDef<T> {
  return def;
}

const tools = [
  // ---- Read (v0.2.0) ----
  tool({ name: 'get_document', description: 'Read a Google Doc and return its paragraph-level structure: text, indices, named style, alignment, and optional inline style runs. Use this BEFORE editing a doc to know what is actually there.', schema: getDocumentSchema, handler: getDocument }),
  tool({ name: 'get_spreadsheet', description: 'Read a Google Sheet and return its tab metadata (sheet IDs, titles, row/column counts) and optionally cell values. Counterpart to get_document for Sheets.', schema: getSpreadsheetSchema, handler: getSpreadsheet }),
  tool({ name: 'get_file_metadata', description: 'Get owner, size, mime type, parents, sharing state, web links, and other metadata for any Drive file or folder.', schema: getFileMetadataSchema, handler: getFileMetadata }),

  // ---- Drive ----
  tool({ name: 'move_file', description: 'Move a Drive file or folder to a different parent folder.', schema: moveFileSchema, handler: moveFile }),
  tool({ name: 'rename_file', description: 'Rename a Drive file or folder (changes title only; file ID stable).', schema: renameFileSchema, handler: renameFile }),
  tool({ name: 'delete_file', description: '[DESTRUCTIVE] Delete a Drive file or folder. Default trashes (recoverable 30 days). permanent=true ALONE falls back to trash; pair with confirm_permanent=true for irrecoverable deletion.', schema: deleteFileSchema, handler: deleteFile }),
  tool({ name: 'restore_file', description: 'Restore a trashed file. Only works for trashed files, not permanently deleted ones.', schema: restoreFileSchema, handler: restoreFile }),
  tool({ name: 'list_folder', description: 'List a Drive folder contents. Sorted folders-first then alphabetically.', schema: listFolderSchema, handler: listFolder }),
  tool({ name: 'create_folder', description: 'Create a new Drive folder. Optionally inside a specific parent folder (defaults to root).', schema: createFolderSchema, handler: createFolder }),
  tool({ name: 'create_doc', description: 'Create a new Google Doc with optional initial content. Lands in the target folder (defaults to root).', schema: createDocSchema, handler: createDoc }),
  tool({ name: 'create_sheet', description: 'Create a new Google Sheets spreadsheet with a named first tab. Lands in the target folder (defaults to root).', schema: createSheetSchema, handler: createSheet }),
  tool({ name: 'copy_file', description: 'Copy a Drive file. Bundles copy + optional rename + optional target folder in one call.', schema: copyFileSchema, handler: copyFile }),
  tool({ name: 'search_files', description: 'Search Drive by name, full text, mime type, parent folder, modification time, or raw Drive query syntax.', schema: searchFilesSchema, handler: searchFiles }),

  // ---- Docs ----
  tool({ name: 'find_and_replace', description: 'Find and replace text across a Google Doc. Pass dry_run=true to count occurrences without modifying. Returns count of occurrences changed.', schema: findAndReplaceSchema, handler: findAndReplace }),
  tool({ name: 'append_to_doc', description: 'Append text to the end of a Google Doc. Use for logs, journals, running notes.', schema: appendToDocSchema, handler: appendToDoc }),
  tool({ name: 'insert_at_heading', description: 'Insert content after (or before) a specific heading or paragraph identified by exact text.', schema: insertAtHeadingSchema, handler: insertAtHeading }),
  tool({ name: 'apply_text_style', description: 'Apply text formatting (bold, italic, underline, strikethrough, font size, color) to all occurrences of given text.', schema: applyTextStyleSchema, handler: applyTextStyle }),
  tool({ name: 'apply_paragraph_style', description: 'Promote a paragraph to a heading style (HEADING_1..HEADING_6, TITLE, SUBTITLE, NORMAL_TEXT) or set alignment, indent, line spacing.', schema: applyParagraphStyleSchema, handler: applyParagraphStyle }),
  tool({ name: 'delete_paragraph', description: '[DESTRUCTIVE] Remove a paragraph cleanly, including its trailing newline (no blank line left behind). Match by exact text.', schema: deleteParagraphSchema, handler: deleteParagraph }),
  tool({ name: 'insert_table', description: 'Insert an empty table with N rows x M columns at an anchor paragraph. Populate cells with update_table_cell.', schema: insertTableSchema, handler: insertTable }),
  tool({ name: 'update_table_cell', description: 'Set the content of a specific table cell (table_index, row, column).', schema: updateTableCellSchema, handler: updateTableCell }),
  tool({ name: 'insert_image', description: 'Insert an inline image from a URL at an anchor paragraph. Optional explicit width/height in points.', schema: insertImageSchema, handler: insertImage }),
  tool({ name: 'apply_list_style', description: 'Promote a paragraph to a bulleted or numbered list item (or remove list bullets).', schema: applyListStyleSchema, handler: applyListStyle }),

  // ---- Sheets ----
  tool({ name: 'append_row', description: 'Append a row of values to the bottom of a sheet tab. Use for logs (expenses, time entries).', schema: appendRowSchema, handler: appendRow }),
  tool({ name: 'update_cell', description: 'Set a single cell value via A1 notation (e.g., "Sheet1!B7").', schema: updateCellSchema, handler: updateCell }),
  tool({ name: 'update_range', description: 'Set a 2D range of cells in one call. Values are rows x columns.', schema: updateRangeSchema, handler: updateRange }),
  tool({ name: 'find_and_replace_in_sheet', description: 'Find and replace text across one sheet or the whole spreadsheet. Pass dry_run=true to count occurrences without modifying.', schema: findAndReplaceInSheetSchema, handler: findAndReplaceInSheet }),
  tool({ name: 'add_sheet', description: 'Add a new sheet tab to an existing spreadsheet.', schema: addSheetSchema, handler: addSheet }),
  tool({ name: 'delete_sheet', description: 'Delete a sheet tab from a spreadsheet by sheet_id.', schema: deleteSheetSchema, handler: deleteSheet }),
  tool({ name: 'rename_sheet', description: 'Rename a sheet tab (title only).', schema: renameSheetSchema, handler: renameSheet }),
  tool({ name: 'format_range', description: 'Apply cell formatting (bold, color, alignment, number format, borders) to a range.', schema: formatRangeSchema, handler: formatRange }),
  tool({ name: 'delete_rows', description: 'Delete a contiguous range of rows from a sheet by zero-based indices.', schema: deleteRowsSchema, handler: deleteRows }),
  tool({ name: 'delete_columns', description: 'Delete a contiguous range of columns from a sheet by zero-based indices.', schema: deleteColumnsSchema, handler: deleteColumns }),
  tool({ name: 'insert_rows', description: 'Insert N empty rows at a specific position. Optionally inherit formatting from the row above.', schema: insertRowsSchema, handler: insertRows }),
  tool({ name: 'insert_columns', description: 'Insert N empty columns at a specific position. Optionally inherit formatting from the column to the left.', schema: insertColumnsSchema, handler: insertColumns }),
  tool({ name: 'create_chart', description: 'Add a chart (COLUMN/BAR/LINE/AREA/PIE/SCATTER/COMBO/HISTOGRAM) sourcing from a data range.', schema: createChartSchema, handler: createChart }),
  tool({ name: 'add_data_validation', description: 'Apply a data validation rule (dropdown list, number range, date range, custom formula, etc.) to a range.', schema: addDataValidationSchema, handler: addDataValidation }),

  // ---- Permissions ----
  tool({ name: 'share_file', description: '[EXPOSES DATA] Share a file. type=anyone exposes the file to the public web; respect ALLOW_PUBLIC_SHARING env var when set to false.', schema: shareFileSchema, handler: shareFile }),
  tool({ name: 'list_permissions', description: 'List the current ACL on a file: who has access, what role.', schema: listPermissionsSchema, handler: listPermissions }),
  tool({ name: 'revoke_permission', description: '[DESTRUCTIVE] Revoke a permission by ID. Refuses to revoke your own access unless force_revoke_self=true (self-lockout protection).', schema: revokePermissionSchema, handler: revokePermission }),
  tool({ name: 'create_share_link', description: '[EXPOSES DATA] Generate a public share link (anyone-with-link). Anyone with the URL gets access. Respects ALLOW_PUBLIC_SHARING env var.', schema: createShareLinkSchema, handler: createShareLink }),

  // ---- Batch ----
  tool({ name: 'batch_doc_update', description: 'Apply multiple Doc edits atomically in one batchUpdate call. Faster, cheaper, and atomic compared to N tool calls.', schema: batchDocUpdateSchema, handler: batchDocUpdate }),
  tool({ name: 'batch_sheet_update', description: 'Apply multiple Sheet edits in one logical batch (values + structural ops grouped).', schema: batchSheetUpdateSchema, handler: batchSheetUpdate }),
  tool({ name: 'batch_move', description: '[DESTRUCTIVE] Move many files into a target folder in one call. Pass dry_run=true to preview without moving. Returns succeeded + failed arrays.', schema: batchMoveSchema, handler: batchMove }),
  tool({ name: 'batch_delete', description: '[DESTRUCTIVE] Delete many files in one call. Default trashes. permanent=true ALONE falls back to trash; permanent=true + confirm_permanent=true is required for irrecoverable deletion (capped at 20 files). Pass dry_run=true to preview.', schema: batchDeleteSchema, handler: batchDelete }),

  // ---- Comments / Suggestions ----
  tool({ name: 'add_comment', description: 'Add a comment to a Drive file (Doc/Sheet/Slide/most file types).', schema: addCommentSchema, handler: addComment }),
  tool({ name: 'list_comments', description: 'List comments on a file. Optionally filter by resolved/deleted state.', schema: listCommentsSchema, handler: listComments }),
  tool({ name: 'resolve_comment', description: 'Mark a comment as resolved.', schema: resolveCommentSchema, handler: resolveComment }),
  tool({ name: 'accept_all_suggestions', description: 'Accept all pending tracked-change suggestions in a Doc. NOTE: Docs API does not support bulk accept; this currently surfaces a structured error.', schema: acceptAllSuggestionsSchema, handler: acceptAllSuggestions }),
  tool({ name: 'reject_all_suggestions', description: 'Reject all pending tracked-change suggestions in a Doc. NOTE: Docs API does not support bulk reject; this currently surfaces a structured error.', schema: rejectAllSuggestionsSchema, handler: rejectAllSuggestions }),

  // ---- Exports ----
  tool({ name: 'export_to_pdf', description: 'Export a Google Doc, Sheet, or Slide to PDF. Returns base64-encoded bytes.', schema: exportToPdfSchema, handler: exportToPdf }),
  tool({ name: 'export_to_docx', description: 'Export a Google Doc to Microsoft Word DOCX. Returns base64-encoded bytes.', schema: exportToDocxSchema, handler: exportToDocx }),
  tool({ name: 'export_to_xlsx', description: 'Export a Google Sheet to Microsoft Excel XLSX. Returns base64-encoded bytes.', schema: exportToXlsxSchema, handler: exportToXlsx }),
  tool({ name: 'get_thumbnail', description: 'Get a Drive file thumbnail link (short-lived, ~1 hour TTL).', schema: getThumbnailSchema, handler: getThumbnail }),
] as const;

const server = new Server(
  { name: 'armoryworks-drive-mcp', version: '0.2.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => {
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema, { target: 'jsonSchema7' }) as Record<string, unknown>,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const def = tools.find((t) => t.name === name);

  if (!def) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: 'Unknown tool: ' + name }],
    };
  }

  const parsed = def.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: 'Invalid arguments for ' + name + ': ' + parsed.error.message,
        },
      ],
    };
  }

  log('debug', 'tool_call_start', { tool: name });
  const handler = def.handler as (input: unknown) => Promise<unknown>;
  const result = await wrapToolErrors(name, () => withRetry(name, () => handler(parsed.data)));

  if (!result.ok) {
    log('warn', 'tool_call_failed', { tool: name, code: result.error.code });
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: '[' + result.error.code + '] ' + result.error.message,
        },
      ],
    };
  }

  log('debug', 'tool_call_done', { tool: name });
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(result.value, null, 2) },
    ],
  };
});

async function main(): Promise<void> {
  const authed = await hasValidAuth().catch(() => false);
  if (!authed) {
    process.stderr.write(
      'armoryworks-drive-mcp: no valid OAuth tokens found.\n' +
        'Run: npx -y -p @armoryworks/drive-mcp armoryworks-drive-mcp-auth\n' +
        'See README.md and docs/oauth-setup.md for instructions.\n',
    );
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', 'server_started', { version: '0.2.0', tool_count: tools.length });
}

main().catch((err: unknown) => {
  process.stderr.write('armoryworks-drive-mcp: fatal error: ' + String(err) + '\n');
  process.exit(1);
});
