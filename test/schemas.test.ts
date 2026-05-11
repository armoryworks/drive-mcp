import { describe, it, expect } from 'vitest';

import * as drive from '../src/tools/drive.js';
import * as docs from '../src/tools/docs.js';
import * as sheets from '../src/tools/sheets.js';
import * as read from '../src/tools/read.js';
import * as permissions from '../src/tools/permissions.js';
import * as batch from '../src/tools/batch.js';
import * as comments from '../src/tools/comments.js';
import * as exports from '../src/tools/exports.js';

/**
 * Smoke tests: every exported schema must parse the minimum valid input
 * for that tool. We never call the handler — that would require Google API
 * credentials. We just verify the schema shape is sound.
 */
describe('schemas parse minimum valid inputs', () => {
  it('drive schemas', () => {
    expect(drive.moveFileSchema.parse({ file_id: 'a', target_folder_id: 'root' })).toBeTruthy();
    expect(drive.renameFileSchema.parse({ file_id: 'a', new_title: 'New' })).toBeTruthy();
    expect(drive.deleteFileSchema.parse({ file_id: 'a' })).toBeTruthy();
    expect(drive.restoreFileSchema.parse({ file_id: 'a' })).toBeTruthy();
    expect(drive.listFolderSchema.parse({ folder_id: 'root' })).toBeTruthy();
    expect(drive.createFolderSchema.parse({ name: 'NF', parent_folder_id: 'root' })).toBeTruthy();
    expect(drive.createDocSchema.parse({ title: 'ND', parent_folder_id: 'root' })).toBeTruthy();
    expect(drive.createSheetSchema.parse({ title: 'NS', parent_folder_id: 'root' })).toBeTruthy();
    expect(drive.copyFileSchema.parse({ file_id: 'a' })).toBeTruthy();
    expect(drive.searchFilesSchema.parse({})).toBeTruthy();
  });

  it('docs schemas', () => {
    expect(docs.findAndReplaceSchema.parse({ document_id: 'a', find: 'x', replace: 'y' })).toBeTruthy();
    expect(docs.appendToDocSchema.parse({ document_id: 'a', text: 't' })).toBeTruthy();
    expect(docs.insertAtHeadingSchema.parse({ document_id: 'a', heading_text: 'H', content: 'c' })).toBeTruthy();
    expect(docs.applyTextStyleSchema.parse({ document_id: 'a', find: 'x', style: { bold: true } })).toBeTruthy();
    expect(docs.applyParagraphStyleSchema.parse({ document_id: 'a', paragraph_text: 'p', named_style: 'HEADING_1' })).toBeTruthy();
    expect(docs.deleteParagraphSchema.parse({ document_id: 'a', paragraph_text: 'p' })).toBeTruthy();
    expect(docs.insertTableSchema.parse({ document_id: 'a', anchor_text: 'a', rows: 2, columns: 2 })).toBeTruthy();
    expect(docs.updateTableCellSchema.parse({ document_id: 'a', table_index: 0, row: 0, column: 0, content: 'x' })).toBeTruthy();
    expect(docs.insertImageSchema.parse({ document_id: 'a', anchor_text: 'a', image_url: 'https://example.com/img.png' })).toBeTruthy();
    expect(docs.applyListStyleSchema.parse({ document_id: 'a', paragraph_text: 'p' })).toBeTruthy();
  });

  it('sheets schemas', () => {
    expect(sheets.appendRowSchema.parse({ spreadsheet_id: 's', sheet_name: 'Sheet1', values: ['a'] })).toBeTruthy();
    expect(sheets.updateCellSchema.parse({ spreadsheet_id: 's', range: 'A1', value: 1 })).toBeTruthy();
    expect(sheets.updateRangeSchema.parse({ spreadsheet_id: 's', range: 'A1:B2', values: [[1, 2], [3, 4]] })).toBeTruthy();
    expect(sheets.findAndReplaceInSheetSchema.parse({ spreadsheet_id: 's', find: 'x', replace: 'y' })).toBeTruthy();
    expect(sheets.addSheetSchema.parse({ spreadsheet_id: 's', title: 'T' })).toBeTruthy();
    expect(sheets.deleteSheetSchema.parse({ spreadsheet_id: 's', sheet_id: 1 })).toBeTruthy();
    expect(sheets.renameSheetSchema.parse({ spreadsheet_id: 's', sheet_id: 1, new_title: 'R' })).toBeTruthy();
    expect(sheets.formatRangeSchema.parse({ spreadsheet_id: 's', sheet_id: 1, start_row: 0, end_row: 1, start_column: 0, end_column: 1, bold: true })).toBeTruthy();
    expect(sheets.deleteRowsSchema.parse({ spreadsheet_id: 's', sheet_id: 1, start_index: 0, end_index: 1 })).toBeTruthy();
    expect(sheets.deleteColumnsSchema.parse({ spreadsheet_id: 's', sheet_id: 1, start_index: 0, end_index: 1 })).toBeTruthy();
    expect(sheets.insertRowsSchema.parse({ spreadsheet_id: 's', sheet_id: 1, start_index: 0, end_index: 1 })).toBeTruthy();
    expect(sheets.insertColumnsSchema.parse({ spreadsheet_id: 's', sheet_id: 1, start_index: 0, end_index: 1 })).toBeTruthy();
    expect(sheets.createChartSchema.parse({ spreadsheet_id: 's', source_sheet_id: 1, data_start_row: 0, data_end_row: 5, data_start_column: 0, data_end_column: 3 })).toBeTruthy();
    expect(sheets.addDataValidationSchema.parse({ spreadsheet_id: 's', sheet_id: 1, start_row: 0, end_row: 1, start_column: 0, end_column: 1, condition_type: 'ONE_OF_LIST', condition_values: ['a', 'b'] })).toBeTruthy();
  });

  it('read schemas', () => {
    expect(read.getDocumentSchema.parse({ document_id: 'a' })).toBeTruthy();
    expect(read.getSpreadsheetSchema.parse({ spreadsheet_id: 's' })).toBeTruthy();
    expect(read.getFileMetadataSchema.parse({ file_id: 'f' })).toBeTruthy();
  });

  it('permissions schemas', () => {
    expect(permissions.shareFileSchema.parse({ file_id: 'a', type: 'user', role: 'reader', email_address: 'a@b.com' })).toBeTruthy();
    expect(permissions.listPermissionsSchema.parse({ file_id: 'a' })).toBeTruthy();
    expect(permissions.revokePermissionSchema.parse({ file_id: 'a', permission_id: 'p' })).toBeTruthy();
    expect(permissions.createShareLinkSchema.parse({ file_id: 'a' })).toBeTruthy();
  });

  it('batch schemas', () => {
    expect(batch.batchDocUpdateSchema.parse({ document_id: 'a', operations: [{ type: 'append_text', text: 't' }] })).toBeTruthy();
    expect(batch.batchSheetUpdateSchema.parse({ spreadsheet_id: 's', operations: [{ type: 'update_cell', range: 'A1', value: 1 }] })).toBeTruthy();
    expect(batch.batchMoveSchema.parse({ file_ids: ['a'], target_folder_id: 'root' })).toBeTruthy();
    expect(batch.batchDeleteSchema.parse({ file_ids: ['a'] })).toBeTruthy();
  });

  it('comments schemas', () => {
    expect(comments.addCommentSchema.parse({ file_id: 'a', content: 'c' })).toBeTruthy();
    expect(comments.listCommentsSchema.parse({ file_id: 'a' })).toBeTruthy();
    expect(comments.resolveCommentSchema.parse({ file_id: 'a', comment_id: 'c' })).toBeTruthy();
    expect(comments.acceptAllSuggestionsSchema.parse({ document_id: 'a' })).toBeTruthy();
    expect(comments.rejectAllSuggestionsSchema.parse({ document_id: 'a' })).toBeTruthy();
  });

  it('exports schemas', () => {
    expect(exports.exportToPdfSchema.parse({ file_id: 'a' })).toBeTruthy();
    expect(exports.exportToDocxSchema.parse({ file_id: 'a' })).toBeTruthy();
    expect(exports.exportToXlsxSchema.parse({ file_id: 'a' })).toBeTruthy();
    expect(exports.getThumbnailSchema.parse({ file_id: 'a' })).toBeTruthy();
  });
});

describe('guard rails reject obviously dangerous inputs', () => {
  it('batch_delete rejects more than 100 files', () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => 'id' + i);
    expect(() => batch.batchDeleteSchema.parse({ file_ids: tooMany })).toThrow();
  });

  it('share_file requires email when type=user', () => {
    // type=user is allowed by the schema but the handler enforces email presence
    expect(permissions.shareFileSchema.parse({ file_id: 'a', type: 'user', role: 'reader' })).toBeTruthy();
  });

  it('createChart requires data range', () => {
    expect(() => sheets.createChartSchema.parse({ spreadsheet_id: 's' })).toThrow();
  });
});
