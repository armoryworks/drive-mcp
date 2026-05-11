/**
 * Drive operation tools.
 *
 * v0.1.x covered the write-gap in Google's official Drive MCP: move, rename,
 * delete, restore, list_folder.
 *
 * v0.2.0 expands to full lifecycle: create_folder, create_doc, create_sheet,
 * copy_file, search_files. With these we no longer depend on the official
 * MCP for creation — this MCP is now a complete Drive toolkit.
 */

import { z } from 'zod';
import type { drive_v3 } from 'googleapis';
import { getGoogleClients } from '../google.js';
import { log } from '../lib/retry.js';
import { assertFileNotInProtectedFolder, assertRateLimit } from '../lib/guards.js';

// =========================================================================
// move_file
// =========================================================================

export const moveFileSchema = z.object({
  file_id: z.string().min(1).describe('Drive file ID of the file or folder to move. Find via search or list_folder.'),
  target_folder_id: z.string().min(1).describe("Drive folder ID to move the file into. Use 'root' for the user's My Drive root."),
});

export type MoveFileInput = z.infer<typeof moveFileSchema>;

export async function moveFile(input: MoveFileInput): Promise<{
  id: string; name: string; parents: string[]; webViewLink?: string;
}> {
  await assertFileNotInProtectedFolder(input.file_id, 'move_file');
  const { drive } = await getGoogleClients();
  const current = await drive.files.get({ fileId: input.file_id, fields: 'parents', supportsAllDrives: true });
  const previousParents = (current.data.parents ?? []).join(',');
  const moved = await drive.files.update({
    fileId: input.file_id,
    addParents: input.target_folder_id,
    removeParents: previousParents,
    fields: 'id, name, parents, webViewLink',
    supportsAllDrives: true,
  });
  return {
    id: moved.data.id ?? input.file_id,
    name: moved.data.name ?? '',
    parents: moved.data.parents ?? [],
    ...(moved.data.webViewLink ? { webViewLink: moved.data.webViewLink } : {}),
  };
}

// =========================================================================
// rename_file
// =========================================================================

export const renameFileSchema = z.object({
  file_id: z.string().min(1).describe('Drive file ID of the file or folder to rename.'),
  new_title: z.string().min(1).describe('New title for the file or folder.'),
});

export type RenameFileInput = z.infer<typeof renameFileSchema>;

export async function renameFile(input: RenameFileInput): Promise<{
  id: string; name: string; webViewLink?: string;
}> {
  const { drive } = await getGoogleClients();
  const renamed = await drive.files.update({
    fileId: input.file_id,
    requestBody: { name: input.new_title },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });
  return {
    id: renamed.data.id ?? input.file_id,
    name: renamed.data.name ?? input.new_title,
    ...(renamed.data.webViewLink ? { webViewLink: renamed.data.webViewLink } : {}),
  };
}

// =========================================================================
// delete_file
// =========================================================================

export const deleteFileSchema = z.object({
  file_id: z.string().min(1).describe('Drive file ID of the file or folder to delete.'),
  permanent: z.boolean().default(false).describe('If true AND confirm_permanent is also true, permanently deletes the file (cannot be recovered). Otherwise moves to Trash (recoverable for 30 days).'),
  confirm_permanent: z.boolean().default(false).describe('Required second confirmation for permanent deletion. Pass true to authorize. Without this, "permanent: true" falls back to trash and a warning is returned.'),
});

export type DeleteFileInput = z.infer<typeof deleteFileSchema>;

export async function deleteFile(input: DeleteFileInput): Promise<{
  id: string; deleted: 'trashed' | 'permanent';
  warning?: string;
}> {
  assertRateLimit('delete_file');
  await assertFileNotInProtectedFolder(input.file_id, 'delete_file');
  const { drive } = await getGoogleClients();

  // Two-axis confirmation for permanent delete: both permanent AND
  // confirm_permanent must be true. Otherwise fall back to trash.
  if (input.permanent && input.confirm_permanent) {
    log('info', 'destructive_op', { tool: 'delete_file', mode: 'permanent', file_id: input.file_id });
    await drive.files.delete({ fileId: input.file_id, supportsAllDrives: true });
    return { id: input.file_id, deleted: 'permanent' };
  }

  log('info', 'destructive_op', { tool: 'delete_file', mode: 'trashed', file_id: input.file_id });
  await drive.files.update({
    fileId: input.file_id,
    requestBody: { trashed: true },
    supportsAllDrives: true,
  });
  const result: { id: string; deleted: 'trashed' | 'permanent'; warning?: string } = {
    id: input.file_id,
    deleted: 'trashed',
  };
  if (input.permanent && !input.confirm_permanent) {
    result.warning = 'permanent=true was requested but confirm_permanent was not set; fell back to trash. Pass confirm_permanent=true alongside permanent=true to authorize irrecoverable deletion.';
  }
  return result;
}

// =========================================================================
// restore_file
// =========================================================================

export const restoreFileSchema = z.object({
  file_id: z.string().min(1).describe('Drive file ID of the trashed file to restore. Only works for trashed files, not permanently deleted ones.'),
});

export type RestoreFileInput = z.infer<typeof restoreFileSchema>;

export async function restoreFile(input: RestoreFileInput): Promise<{ id: string; name: string }> {
  const { drive } = await getGoogleClients();
  const restored = await drive.files.update({
    fileId: input.file_id,
    requestBody: { trashed: false },
    fields: 'id, name',
    supportsAllDrives: true,
  });
  return { id: restored.data.id ?? input.file_id, name: restored.data.name ?? '' };
}

// =========================================================================
// list_folder
// =========================================================================

export const listFolderSchema = z.object({
  folder_id: z.string().min(1).default('root').describe("Drive folder ID to list contents of. Use 'root' for the user's My Drive root."),
  include_trashed: z.boolean().default(false).describe('If true, includes trashed files in the listing.'),
  page_size: z.number().int().min(1).max(1000).default(100).describe('Maximum number of files to return.'),
});

export type ListFolderInput = z.infer<typeof listFolderSchema>;

export async function listFolder(input: ListFolderInput): Promise<{
  files: Array<{
    id: string; name: string; mimeType: string;
    modifiedTime?: string; size?: string; webViewLink?: string;
  }>;
  nextPageToken?: string;
}> {
  const { drive } = await getGoogleClients();
  const trashedClause = input.include_trashed ? '' : ' and trashed = false';
  const q = `'${input.folder_id}' in parents${trashedClause}`;
  const result = await drive.files.list({
    q,
    pageSize: input.page_size,
    fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size, webViewLink)',
    orderBy: 'folder, name',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files: drive_v3.Schema$File[] = result.data.files ?? [];
  return {
    files: files.map((f: drive_v3.Schema$File) => ({
      id: f.id ?? '',
      name: f.name ?? '',
      mimeType: f.mimeType ?? '',
      ...(f.modifiedTime ? { modifiedTime: f.modifiedTime } : {}),
      ...(f.size ? { size: f.size } : {}),
      ...(f.webViewLink ? { webViewLink: f.webViewLink } : {}),
    })),
    ...(result.data.nextPageToken ? { nextPageToken: result.data.nextPageToken } : {}),
  };
}

// =========================================================================
// create_folder
// =========================================================================

export const createFolderSchema = z.object({
  name: z.string().min(1).describe('Name of the new folder.'),
  parent_folder_id: z.string().min(1).default('root').describe("Drive folder ID to create the new folder inside. Use 'root' (default) for My Drive root."),
});

export type CreateFolderInput = z.infer<typeof createFolderSchema>;

export async function createFolder(input: CreateFolderInput): Promise<{
  id: string; name: string; parents: string[]; webViewLink?: string;
}> {
  const { drive } = await getGoogleClients();
  const created = await drive.files.create({
    requestBody: {
      name: input.name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [input.parent_folder_id],
    },
    fields: 'id, name, parents, webViewLink',
    supportsAllDrives: true,
  });
  return {
    id: created.data.id ?? '',
    name: created.data.name ?? input.name,
    parents: created.data.parents ?? [],
    ...(created.data.webViewLink ? { webViewLink: created.data.webViewLink } : {}),
  };
}

// =========================================================================
// create_doc
// =========================================================================

export const createDocSchema = z.object({
  title: z.string().min(1).describe('Title of the new Google Doc.'),
  parent_folder_id: z.string().min(1).default('root').describe("Drive folder ID to create the doc inside. Use 'root' (default) for My Drive root."),
  initial_content: z.string().optional().describe('Optional initial text content. Inserted at the start of the doc after creation.'),
});

export type CreateDocInput = z.infer<typeof createDocSchema>;

export async function createDoc(input: CreateDocInput): Promise<{
  id: string; title: string; parents: string[]; webViewLink?: string;
}> {
  const { drive, docs } = await getGoogleClients();
  const created = await drive.files.create({
    requestBody: {
      name: input.title,
      mimeType: 'application/vnd.google-apps.document',
      parents: [input.parent_folder_id],
    },
    fields: 'id, name, parents, webViewLink',
    supportsAllDrives: true,
  });
  const docId = created.data.id ?? '';
  if (input.initial_content && docId) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [{ insertText: { endOfSegmentLocation: {}, text: input.initial_content } }],
      },
    });
  }
  return {
    id: docId,
    title: created.data.name ?? input.title,
    parents: created.data.parents ?? [],
    ...(created.data.webViewLink ? { webViewLink: created.data.webViewLink } : {}),
  };
}

// =========================================================================
// create_sheet
// =========================================================================

export const createSheetSchema = z.object({
  title: z.string().min(1).describe('Title of the new Google Sheets spreadsheet.'),
  parent_folder_id: z.string().min(1).default('root').describe("Drive folder ID to create the spreadsheet inside. Use 'root' (default) for My Drive root."),
  initial_sheet_name: z.string().min(1).default('Sheet1').describe("Name of the first sheet tab. Default 'Sheet1'."),
});

export type CreateSheetInput = z.infer<typeof createSheetSchema>;

export async function createSheet(input: CreateSheetInput): Promise<{
  id: string; title: string; parents: string[]; webViewLink?: string;
  sheets: Array<{ sheet_id: number; title: string }>;
}> {
  const { drive, sheets } = await getGoogleClients();
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: input.title },
      sheets: [{ properties: { title: input.initial_sheet_name } }],
    },
  });
  const spreadsheetId = created.data.spreadsheetId ?? '';
  let webViewLink: string | undefined;
  let parents: string[] = [];
  if (spreadsheetId) {
    if (input.parent_folder_id !== 'root') {
      const current = await drive.files.get({
        fileId: spreadsheetId, fields: 'parents, webViewLink', supportsAllDrives: true,
      });
      const previousParents = (current.data.parents ?? []).join(',');
      const moved = await drive.files.update({
        fileId: spreadsheetId,
        addParents: input.parent_folder_id,
        removeParents: previousParents,
        fields: 'parents, webViewLink',
        supportsAllDrives: true,
      });
      parents = moved.data.parents ?? [];
      webViewLink = moved.data.webViewLink ?? current.data.webViewLink ?? undefined;
    } else {
      const meta = await drive.files.get({
        fileId: spreadsheetId, fields: 'parents, webViewLink', supportsAllDrives: true,
      });
      parents = meta.data.parents ?? [];
      webViewLink = meta.data.webViewLink ?? undefined;
    }
  }
  return {
    id: spreadsheetId,
    title: created.data.properties?.title ?? input.title,
    parents,
    ...(webViewLink ? { webViewLink } : {}),
    sheets: (created.data.sheets ?? []).map((s) => ({
      sheet_id: s.properties?.sheetId ?? 0,
      title: s.properties?.title ?? '',
    })),
  };
}

// =========================================================================
// copy_file
// =========================================================================

export const copyFileSchema = z.object({
  file_id: z.string().min(1).describe('Drive file ID to copy.'),
  new_name: z.string().min(1).optional().describe('Name for the copy. If omitted, Google uses "Copy of <original>".'),
  target_folder_id: z.string().min(1).optional().describe('Drive folder ID to place the copy in. If omitted, the copy lands in the same parent as the original.'),
});

export type CopyFileInput = z.infer<typeof copyFileSchema>;

export async function copyFile(input: CopyFileInput): Promise<{
  id: string; name: string; parents: string[]; webViewLink?: string;
}> {
  const { drive } = await getGoogleClients();
  const requestBody: drive_v3.Schema$File = {};
  if (input.new_name) requestBody.name = input.new_name;
  if (input.target_folder_id) requestBody.parents = [input.target_folder_id];
  const copied = await drive.files.copy({
    fileId: input.file_id,
    requestBody,
    fields: 'id, name, parents, webViewLink',
    supportsAllDrives: true,
  });
  return {
    id: copied.data.id ?? '',
    name: copied.data.name ?? '',
    parents: copied.data.parents ?? [],
    ...(copied.data.webViewLink ? { webViewLink: copied.data.webViewLink } : {}),
  };
}

// =========================================================================
// search_files
// =========================================================================

export const searchFilesSchema = z.object({
  name_contains: z.string().optional().describe("Search files whose name contains this substring (case-insensitive)."),
  full_text: z.string().optional().describe("Search file contents and metadata for this string."),
  mime_type: z.string().optional().describe("Filter to files of this mime type (e.g., 'application/vnd.google-apps.document', 'application/vnd.google-apps.folder', 'application/pdf')."),
  parent_folder_id: z.string().optional().describe('Filter to files inside this folder.'),
  modified_after: z.string().optional().describe('ISO-8601 datetime. Returns only files modified strictly after this timestamp.'),
  include_trashed: z.boolean().default(false).describe('Include trashed files in results.'),
  q: z.string().optional().describe("Raw Drive search query. If provided, the convenience filters are ignored. See https://developers.google.com/drive/api/v3/reference/query-ref for syntax."),
  page_size: z.number().int().min(1).max(1000).default(50).describe('Maximum number of results to return.'),
  page_token: z.string().optional().describe('Opaque pagination cursor returned from a previous call.'),
  order_by: z.string().optional().describe("Comma-separated sort keys. Examples: 'modifiedTime desc', 'name', 'folder,name'."),
});

export type SearchFilesInput = z.infer<typeof searchFilesSchema>;

export async function searchFiles(input: SearchFilesInput): Promise<{
  files: Array<{
    id: string; name: string; mimeType: string;
    modifiedTime?: string; parents?: string[]; size?: string; webViewLink?: string;
  }>;
  nextPageToken?: string;
}> {
  const { drive } = await getGoogleClients();
  let q: string;
  if (input.q) {
    q = input.q;
  } else {
    const clauses: string[] = [];
    if (input.name_contains) clauses.push(`name contains '${escapeForDriveQuery(input.name_contains)}'`);
    if (input.full_text) clauses.push(`fullText contains '${escapeForDriveQuery(input.full_text)}'`);
    if (input.mime_type) clauses.push(`mimeType = '${escapeForDriveQuery(input.mime_type)}'`);
    if (input.parent_folder_id) clauses.push(`'${escapeForDriveQuery(input.parent_folder_id)}' in parents`);
    if (input.modified_after) clauses.push(`modifiedTime > '${input.modified_after}'`);
    if (!input.include_trashed) clauses.push('trashed = false');
    q = clauses.join(' and ');
  }
  const result = await drive.files.list({
    q: q || undefined,
    pageSize: input.page_size,
    pageToken: input.page_token,
    orderBy: input.order_by,
    fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, parents, size, webViewLink)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files: drive_v3.Schema$File[] = result.data.files ?? [];
  return {
    files: files.map((f: drive_v3.Schema$File) => ({
      id: f.id ?? '',
      name: f.name ?? '',
      mimeType: f.mimeType ?? '',
      ...(f.modifiedTime ? { modifiedTime: f.modifiedTime } : {}),
      ...(f.parents ? { parents: f.parents } : {}),
      ...(f.size ? { size: f.size } : {}),
      ...(f.webViewLink ? { webViewLink: f.webViewLink } : {}),
    })),
    ...(result.data.nextPageToken ? { nextPageToken: result.data.nextPageToken } : {}),
  };
}

/** Escape a string for embedding in a Drive `q` parameter — backslash + apostrophe. */
function escapeForDriveQuery(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
