/**
 * Export tools.
 *
 * Convert Google-native formats (Docs, Sheets, Slides) into downloadable
 * artifacts: PDF, DOCX, XLSX, etc. Output is base64-encoded so it can travel
 * through MCP's JSON-only transport; consumers decode to bytes locally.
 *
 * Tools provided:
 *   - export_to_pdf
 *   - export_to_docx
 *   - export_to_xlsx
 *   - get_thumbnail
 */

import { z } from 'zod';
import { getGoogleClients } from '../google.js';

// =========================================================================
// export_to_pdf
// =========================================================================

export const exportToPdfSchema = z.object({
  file_id: z.string().min(1).describe('Drive file ID. Must be a Google Doc, Sheet, or Slide.'),
});

export type ExportToPdfInput = z.infer<typeof exportToPdfSchema>;

export async function exportToPdf(input: ExportToPdfInput): Promise<{
  file_id: string;
  mime_type: string;
  size_bytes: number;
  base64_content: string;
}> {
  return exportFile(input.file_id, 'application/pdf');
}

// =========================================================================
// export_to_docx
// =========================================================================

export const exportToDocxSchema = z.object({
  file_id: z.string().min(1).describe('Drive file ID. Must be a Google Doc.'),
});

export type ExportToDocxInput = z.infer<typeof exportToDocxSchema>;

export async function exportToDocx(input: ExportToDocxInput): Promise<{
  file_id: string;
  mime_type: string;
  size_bytes: number;
  base64_content: string;
}> {
  return exportFile(
    input.file_id,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
}

// =========================================================================
// export_to_xlsx
// =========================================================================

export const exportToXlsxSchema = z.object({
  file_id: z.string().min(1).describe('Drive file ID. Must be a Google Sheet.'),
});

export type ExportToXlsxInput = z.infer<typeof exportToXlsxSchema>;

export async function exportToXlsx(input: ExportToXlsxInput): Promise<{
  file_id: string;
  mime_type: string;
  size_bytes: number;
  base64_content: string;
}> {
  return exportFile(
    input.file_id,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
}

async function exportFile(
  fileId: string,
  mimeType: string,
): Promise<{
  file_id: string;
  mime_type: string;
  size_bytes: number;
  base64_content: string;
}> {
  const { drive } = await getGoogleClients();
  const result = await drive.files.export(
    { fileId, mimeType },
    { responseType: 'arraybuffer' },
  );
  const buffer = Buffer.from(result.data as ArrayBuffer);
  return {
    file_id: fileId,
    mime_type: mimeType,
    size_bytes: buffer.byteLength,
    base64_content: buffer.toString('base64'),
  };
}

// =========================================================================
// get_thumbnail
// =========================================================================

export const getThumbnailSchema = z.object({
  file_id: z.string().min(1).describe('Drive file ID.'),
});

export type GetThumbnailInput = z.infer<typeof getThumbnailSchema>;

export async function getThumbnail(input: GetThumbnailInput): Promise<{
  file_id: string;
  thumbnail_link?: string;
  has_thumbnail: boolean;
}> {
  const { drive } = await getGoogleClients();
  const result = await drive.files.get({
    fileId: input.file_id,
    fields: 'thumbnailLink, hasThumbnail',
    supportsAllDrives: true,
  });
  return {
    file_id: input.file_id,
    ...(result.data.thumbnailLink ? { thumbnail_link: result.data.thumbnailLink } : {}),
    has_thumbnail: result.data.hasThumbnail ?? false,
  };
}
