/**
 * Drive operation tools.
 *
 * These fill the gap in Google's official Drive MCP, which exposes only
 * read + create operations. We add: move, rename, delete, restore, list_folder.
 *
 * Each tool is a (schema, handler) pair. The schema declares the input shape
 * (the LLM reads this); the handler executes the operation. The handler
 * returns a plain object that the MCP server serializes into the tool
 * response payload.
 */

import { z } from 'zod';
import type { drive_v3 } from 'googleapis';
import { getGoogleClients } from '../google.js';

// =========================================================================
// move_file
// =========================================================================

export const moveFileSchema = z.object({
  file_id: z
    .string()
    .min(1)
    .describe('Drive file ID of the file or folder to move. Find via search or list_folder.'),
  target_folder_id: z
    .string()
    .min(1)
    .describe(
      "Drive folder ID to move the file into. Use 'root' for the user's My Drive root.",
    ),
});

export type MoveFileInput = z.infer<typeof moveFileSchema>;

export async function moveFile(input: MoveFileInput): Promise<{
  id: string;
  name: string;
  parents: string[];
  webViewLink?: string;
}> {
  const { drive } = await getGoogleClients();

  // First read the current parents so we can remove them as part of the move.
  const current = await drive.files.get({
    fileId: input.file_id,
    fields: 'parents',
    supportsAllDrives: true,
  });

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
  id: string;
  name: string;
  webViewLink?: string;
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
  permanent: z
    .boolean()
    .default(false)
    .describe(
      'If true, permanently deletes the file (cannot be recovered). If false (default), moves to Trash where it can be restored within 30 days.',
    ),
});

export type DeleteFileInput = z.infer<typeof deleteFileSchema>;

export async function deleteFile(input: DeleteFileInput): Promise<{
  id: string;
  deleted: 'trashed' | 'permanent';
}> {
  const { drive } = await getGoogleClients();

  if (input.permanent) {
    await drive.files.delete({
      fileId: input.file_id,
      supportsAllDrives: true,
    });
    return { id: input.file_id, deleted: 'permanent' };
  }

  await drive.files.update({
    fileId: input.file_id,
    requestBody: { trashed: true },
    supportsAllDrives: true,
  });
  return { id: input.file_id, deleted: 'trashed' };
}

// =========================================================================
// restore_file
// =========================================================================

export const restoreFileSchema = z.object({
  file_id: z
    .string()
    .min(1)
    .describe('Drive file ID of the trashed file to restore. Only works for trashed files, not permanently deleted ones.'),
});

export type RestoreFileInput = z.infer<typeof restoreFileSchema>;

export async function restoreFile(input: RestoreFileInput): Promise<{
  id: string;
  name: string;
}> {
  const { drive } = await getGoogleClients();

  const restored = await drive.files.update({
    fileId: input.file_id,
    requestBody: { trashed: false },
    fields: 'id, name',
    supportsAllDrives: true,
  });

  return {
    id: restored.data.id ?? input.file_id,
    name: restored.data.name ?? '',
  };
}

// =========================================================================
// list_folder
// =========================================================================

export const listFolderSchema = z.object({
  folder_id: z
    .string()
    .min(1)
    .default('root')
    .describe("Drive folder ID to list contents of. Use 'root' for the user's My Drive root."),
  include_trashed: z
    .boolean()
    .default(false)
    .describe('If true, includes trashed files in the listing.'),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(100)
    .describe('Maximum number of files to return.'),
});

export type ListFolderInput = z.infer<typeof listFolderSchema>;

export async function listFolder(input: ListFolderInput): Promise<{
  files: Array<{
    id: string;
    name: string;
    mimeType: string;
    modifiedTime?: string;
    size?: string;
    webViewLink?: string;
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
