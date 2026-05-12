/**
 * Smoke tests for the tool registry and schema definitions.
 *
 * These tests verify the tool exports exist and that the input schemas
 * reject malformed input. They do NOT exercise the actual Google API
 * calls — those require real credentials and would either need to be
 * mocked or run against a live test Drive account. The "actual API
 * exercise" tests live in a separate integration test suite (not yet
 * included; planned for v0.2).
 */

import { describe, it, expect } from 'vitest';
import {
  moveFileSchema,
  renameFileSchema,
  deleteFileSchema,
  restoreFileSchema,
  listFolderSchema,
} from '../src/tools/drive.js';
import {
  findAndReplaceSchema,
  appendToDocSchema,
  insertAtHeadingSchema,
  applyTextStyleSchema,
} from '../src/tools/docs.js';
import {
  appendRowSchema,
  updateCellSchema,
  updateRangeSchema,
  findAndReplaceInSheetSchema,
} from '../src/tools/sheets.js';

describe('Drive tool schemas', () => {
  it('move_file requires file_id and target_folder_id', () => {
    expect(moveFileSchema.safeParse({}).success).toBe(false);
    expect(moveFileSchema.safeParse({ file_id: 'abc' }).success).toBe(false);
    expect(
      moveFileSchema.safeParse({ file_id: 'abc', target_folder_id: 'def' }).success,
    ).toBe(true);
  });

  it('rename_file requires file_id and new_title', () => {
    expect(renameFileSchema.safeParse({ file_id: 'abc' }).success).toBe(false);
    expect(
      renameFileSchema.safeParse({ file_id: 'abc', new_title: 'New name' }).success,
    ).toBe(true);
  });

  it('delete_file accepts file_id and silently drops removed fields', () => {
    // v0.2.1 removed permanent + confirm_permanent. The schema now accepts
    // only file_id; any extras are stripped by Zod default strip behavior.
    const parsed = deleteFileSchema.safeParse({ file_id: 'abc' });
    expect(parsed.success).toBe(true);
    // Removed-field assertion: 'permanent' is no longer in the parsed shape.
    if (parsed.success) {
      expect('permanent' in parsed.data).toBe(false);
      expect('confirm_permanent' in parsed.data).toBe(false);
    }
    // file_id is the only required field; anything else (legacy) is dropped silently.
    const legacy = deleteFileSchema.safeParse({ file_id: 'abc', permanent: true, confirm_permanent: true });
    expect(legacy.success).toBe(true);
    if (legacy.success) expect('permanent' in legacy.data).toBe(false);
  });

  it('restore_file requires file_id', () => {
    expect(restoreFileSchema.safeParse({}).success).toBe(false);
    expect(restoreFileSchema.safeParse({ file_id: 'abc' }).success).toBe(true);
  });

  it("list_folder defaults to root", () => {
    const parsed = listFolderSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.folder_id).toBe('root');
      expect(parsed.data.page_size).toBe(100);
      expect(parsed.data.include_trashed).toBe(false);
    }
  });

  it('list_folder caps page_size at 1000', () => {
    expect(listFolderSchema.safeParse({ page_size: 0 }).success).toBe(false);
    expect(listFolderSchema.safeParse({ page_size: 1001 }).success).toBe(false);
    expect(listFolderSchema.safeParse({ page_size: 500 }).success).toBe(true);
  });
});

describe('Docs tool schemas', () => {
  it('find_and_replace requires document_id and find', () => {
    expect(findAndReplaceSchema.safeParse({}).success).toBe(false);
    expect(
      findAndReplaceSchema.safeParse({ document_id: 'd', find: 'x', replace: 'y' }).success,
    ).toBe(true);
  });

  it('find_and_replace accepts empty replace string', () => {
    const parsed = findAndReplaceSchema.safeParse({
      document_id: 'd',
      find: 'remove me',
      replace: '',
    });
    expect(parsed.success).toBe(true);
  });

  it('append_to_doc defaults leading_newlines to 2', () => {
    const parsed = appendToDocSchema.safeParse({ document_id: 'd', text: 'hello' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.leading_newlines).toBe(2);
  });

  it('insert_at_heading defaults position to "after"', () => {
    const parsed = insertAtHeadingSchema.safeParse({
      document_id: 'd',
      heading_text: 'H1',
      content: 'new para',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.position).toBe('after');
  });

  it('apply_text_style validates hex color format', () => {
    const bad = applyTextStyleSchema.safeParse({
      document_id: 'd',
      find: 'foo',
      style: { foreground_hex: 'notacolor' },
    });
    expect(bad.success).toBe(false);

    const good = applyTextStyleSchema.safeParse({
      document_id: 'd',
      find: 'foo',
      style: { foreground_hex: '#1a73e8' },
    });
    expect(good.success).toBe(true);
  });
});

describe('Sheets tool schemas', () => {
  it('append_row accepts string, number, and boolean values', () => {
    const parsed = appendRowSchema.safeParse({
      spreadsheet_id: 's',
      sheet_name: 'Sheet1',
      values: ['text', 42, true, ''],
    });
    expect(parsed.success).toBe(true);
  });

  it('append_row defaults value_input_option to USER_ENTERED', () => {
    const parsed = appendRowSchema.safeParse({
      spreadsheet_id: 's',
      sheet_name: 'Sheet1',
      values: ['hello'],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.value_input_option).toBe('USER_ENTERED');
  });

  it('update_cell requires a range', () => {
    const parsed = updateCellSchema.safeParse({
      spreadsheet_id: 's',
      value: 'hi',
    });
    expect(parsed.success).toBe(false);
  });

  it('update_range requires 2D values array', () => {
    const parsed = updateRangeSchema.safeParse({
      spreadsheet_id: 's',
      range: 'A1:B2',
      values: [
        [1, 2],
        [3, 4],
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('find_and_replace_in_sheet defaults match_case to false', () => {
    const parsed = findAndReplaceInSheetSchema.safeParse({
      spreadsheet_id: 's',
      find: 'old',
      replace: 'new',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.match_case).toBe(false);
      expect(parsed.data.match_entire_cell).toBe(false);
    }
  });
});
