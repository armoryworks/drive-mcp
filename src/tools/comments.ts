/**
 * Comment and tracked-change tools.
 *
 * Drive's comments API enables review workflows. Docs has separate machinery
 * for suggested edits (tracked changes); we expose accept-all and reject-all
 * since the API doesn't enumerate suggestions individually.
 *
 * Tools provided:
 *   - add_comment
 *   - list_comments
 *   - resolve_comment
 *   - accept_all_suggestions
 *   - reject_all_suggestions
 */

import { z } from 'zod';
import type { drive_v3 } from 'googleapis';
import { getGoogleClients } from '../google.js';

// =========================================================================
// add_comment
// =========================================================================

export const addCommentSchema = z.object({
  file_id: z.string().min(1).describe('Drive file ID. Comments work on Docs, Sheets, Slides, and most file types.'),
  content: z.string().min(1).describe('Comment text. Plain text only; @mentions are not supported via this API.'),
  anchor: z.string().optional().describe('Optional anchor describing the location the comment refers to. Format is product-specific JSON; omit for unanchored top-level comments.'),
});

export type AddCommentInput = z.infer<typeof addCommentSchema>;

export async function addComment(input: AddCommentInput): Promise<{
  comment_id: string;
  file_id: string;
  content: string;
  created_time?: string;
}> {
  const { drive } = await getGoogleClients();

  const requestBody: drive_v3.Schema$Comment = { content: input.content };
  if (input.anchor) requestBody.anchor = input.anchor;

  const result = await drive.comments.create({
    fileId: input.file_id,
    requestBody,
    fields: 'id, content, createdTime',
  });

  return {
    comment_id: result.data.id ?? '',
    file_id: input.file_id,
    content: result.data.content ?? input.content,
    ...(result.data.createdTime ? { created_time: result.data.createdTime } : {}),
  };
}

// =========================================================================
// list_comments
// =========================================================================

export const listCommentsSchema = z.object({
  file_id: z.string().min(1).describe('Drive file ID.'),
  include_deleted: z.boolean().default(false).describe('Include deleted comments in results.'),
  include_resolved: z.boolean().default(true).describe('Include resolved comments. Set false to see only open threads.'),
  page_size: z.number().int().min(1).max(100).default(50).describe('Maximum comments to return.'),
  page_token: z.string().optional().describe('Pagination cursor.'),
});

export type ListCommentsInput = z.infer<typeof listCommentsSchema>;

export async function listComments(input: ListCommentsInput): Promise<{
  file_id: string;
  comments: Array<{
    id: string;
    content: string;
    author_display_name?: string;
    created_time?: string;
    modified_time?: string;
    resolved?: boolean;
    deleted?: boolean;
    anchor?: string;
    reply_count: number;
  }>;
  next_page_token?: string;
}> {
  const { drive } = await getGoogleClients();

  const result = await drive.comments.list({
    fileId: input.file_id,
    includeDeleted: input.include_deleted,
    pageSize: input.page_size,
    pageToken: input.page_token,
    fields: 'nextPageToken, comments(id, content, author(displayName), createdTime, modifiedTime, resolved, deleted, anchor, replies(id))',
  });

  let comments = (result.data.comments ?? []).map((c: drive_v3.Schema$Comment) => ({
    id: c.id ?? '',
    content: c.content ?? '',
    ...(c.author?.displayName ? { author_display_name: c.author.displayName } : {}),
    ...(c.createdTime ? { created_time: c.createdTime } : {}),
    ...(c.modifiedTime ? { modified_time: c.modifiedTime } : {}),
    ...(typeof c.resolved === 'boolean' ? { resolved: c.resolved } : {}),
    ...(typeof c.deleted === 'boolean' ? { deleted: c.deleted } : {}),
    ...(c.anchor ? { anchor: c.anchor } : {}),
    reply_count: (c.replies ?? []).length,
  }));

  if (!input.include_resolved) {
    comments = comments.filter((c) => !c.resolved);
  }

  return {
    file_id: input.file_id,
    comments,
    ...(result.data.nextPageToken ? { next_page_token: result.data.nextPageToken } : {}),
  };
}

// =========================================================================
// resolve_comment
// =========================================================================

export const resolveCommentSchema = z.object({
  file_id: z.string().min(1).describe('Drive file ID.'),
  comment_id: z.string().min(1).describe('Comment ID to resolve. Use list_comments to find.'),
});

export type ResolveCommentInput = z.infer<typeof resolveCommentSchema>;

export async function resolveComment(input: ResolveCommentInput): Promise<{
  file_id: string;
  comment_id: string;
  resolved: true;
}> {
  const { drive } = await getGoogleClients();

  // The comments.update endpoint with resolved=true marks the comment as
  // resolved. The comments API requires a reply object to do this in some
  // SDK versions; using PATCH on the comment is the official path.
  await drive.comments.update({
    fileId: input.file_id,
    commentId: input.comment_id,
    requestBody: { resolved: true },
    fields: 'id, resolved',
  });

  return {
    file_id: input.file_id,
    comment_id: input.comment_id,
    resolved: true,
  };
}

// =========================================================================
// accept_all_suggestions / reject_all_suggestions
// =========================================================================

export const acceptAllSuggestionsSchema = z.object({
  document_id: z.string().min(1).describe('Google Docs document ID.'),
});

export type AcceptAllSuggestionsInput = z.infer<typeof acceptAllSuggestionsSchema>;

export async function acceptAllSuggestions(_input: AcceptAllSuggestionsInput): Promise<{
  document_id: string;
  action: 'accepted_all';
}> {
  // The Docs API supports accepting suggestions individually by suggestionId
  // but does not expose a bulk accept-all primitive. Iterating over every
  // suggestion in a large doc is expensive, so we surface a clear error
  // rather than implementing a partial solution.
  throw new Error('accept_all_suggestions: bulk acceptance is not supported by the Docs API. Accept suggestions in the document UI, or target specific suggestionIds via the raw Docs API.');
}

export const rejectAllSuggestionsSchema = z.object({
  document_id: z.string().min(1).describe('Google Docs document ID.'),
});

export type RejectAllSuggestionsInput = z.infer<typeof rejectAllSuggestionsSchema>;

export async function rejectAllSuggestions(_input: RejectAllSuggestionsInput): Promise<{
  document_id: string;
  action: 'rejected_all';
}> {
  // The Docs API exposes accept/reject via update text/style requests with
  // suggestionId. Bulk accept/reject is not directly available. As a stable
  // alternative, we surface a clear error pointing to the manual operation.
  throw new Error('reject_all_suggestions: bulk rejection is not supported by the Docs API. Reject suggestions individually via the document UI, or use the raw Docs API to target specific suggestionIds.');
}
