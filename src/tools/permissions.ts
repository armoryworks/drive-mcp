/**
 * Permission and sharing tools.
 *
 * Drive's permissions endpoint lets us manage who can see and edit a file.
 * Google's official Drive MCP exposes none of this. These tools enable
 * collaboration workflows: share a doc with the team, generate a public link,
 * revoke access from a former contractor.
 *
 * Tools provided:
 *   - share_file
 *   - list_permissions
 *   - revoke_permission
 *   - create_share_link
 */

import { z } from 'zod';
import type { drive_v3 } from 'googleapis';
import { getGoogleClients } from '../google.js';
import { log } from '../lib/retry.js';
import { publicSharingAllowed, permissionBelongsToSelf, assertRateLimit } from '../lib/guards.js';

const roleEnum = z.enum(['reader', 'commenter', 'writer', 'fileOrganizer', 'organizer', 'owner']);
const typeEnum = z.enum(['user', 'group', 'domain', 'anyone']);

// =========================================================================
// share_file
// =========================================================================

export const shareFileSchema = z.object({
  file_id: z.string().min(1).describe('Drive file or folder ID to share.'),
  email_address: z.string().email().optional().describe('Email address of the user or group to share with. Required when type is "user" or "group".'),
  domain: z.string().optional().describe('Domain to share with (e.g., "armoryworks.com"). Required when type is "domain".'),
  type: typeEnum.describe('Permission target: "user", "group", "domain", or "anyone".'),
  role: roleEnum.describe('Permission role: "reader" (view), "commenter", "writer" (edit), "fileOrganizer", "organizer", or "owner". Ownership transfer requires special handling.'),
  send_notification_email: z.boolean().default(true).describe('If true (default), Google sends a notification email to the recipient. Set false for silent sharing.'),
  email_message: z.string().optional().describe('Custom message to include in the notification email.'),
});

export type ShareFileInput = z.infer<typeof shareFileSchema>;

export async function shareFile(input: ShareFileInput): Promise<{
  permission_id: string;
  type: string;
  role: string;
  email_address?: string;
  domain?: string;
}> {
  const { drive } = await getGoogleClients();

  const requestBody: drive_v3.Schema$Permission = {
    type: input.type,
    role: input.role,
  };
  if (input.type === 'user' || input.type === 'group') {
    if (!input.email_address) {
      throw new Error('email_address is required when type is "user" or "group".');
    }
    requestBody.emailAddress = input.email_address;
  }
  if (input.type === 'domain') {
    if (!input.domain) {
      throw new Error('domain is required when type is "domain".');
    }
    requestBody.domain = input.domain;
  }

  if (input.type === 'anyone' && !publicSharingAllowed()) {
    throw new Error('Public sharing is disabled by ALLOW_PUBLIC_SHARING=false env var. Use type="user", "group", or "domain" instead.');
  }
  assertRateLimit('share_file');
  if (input.type === 'anyone') {
    log('info', 'destructive_op', { tool: 'share_file', exposure: 'public', file_id: input.file_id, role: input.role });
  } else {
    log('info', 'share_op', { tool: 'share_file', target_type: input.type, role: input.role });
  }
  const result = await drive.permissions.create({
    fileId: input.file_id,
    requestBody,
    sendNotificationEmail: input.send_notification_email,
    emailMessage: input.email_message,
    fields: 'id, type, role, emailAddress, domain',
    supportsAllDrives: true,
  });

  return {
    permission_id: result.data.id ?? '',
    type: result.data.type ?? input.type,
    role: result.data.role ?? input.role,
    ...(result.data.emailAddress ? { email_address: result.data.emailAddress } : {}),
    ...(result.data.domain ? { domain: result.data.domain } : {}),
  };
}

// =========================================================================
// list_permissions
// =========================================================================

export const listPermissionsSchema = z.object({
  file_id: z.string().min(1).describe('Drive file or folder ID to list permissions for.'),
});

export type ListPermissionsInput = z.infer<typeof listPermissionsSchema>;

export async function listPermissions(input: ListPermissionsInput): Promise<{
  file_id: string;
  permissions: Array<{
    id: string;
    type: string;
    role: string;
    email_address?: string;
    display_name?: string;
    domain?: string;
    expiration_time?: string;
    deleted?: boolean;
  }>;
}> {
  const { drive } = await getGoogleClients();

  const result = await drive.permissions.list({
    fileId: input.file_id,
    fields: 'permissions(id, type, role, emailAddress, displayName, domain, expirationTime, deleted)',
    supportsAllDrives: true,
  });

  const perms = (result.data.permissions ?? []).map((p: drive_v3.Schema$Permission) => ({
    id: p.id ?? '',
    type: p.type ?? '',
    role: p.role ?? '',
    ...(p.emailAddress ? { email_address: p.emailAddress } : {}),
    ...(p.displayName ? { display_name: p.displayName } : {}),
    ...(p.domain ? { domain: p.domain } : {}),
    ...(p.expirationTime ? { expiration_time: p.expirationTime } : {}),
    ...(typeof p.deleted === 'boolean' ? { deleted: p.deleted } : {}),
  }));

  return {
    file_id: input.file_id,
    permissions: perms,
  };
}

// =========================================================================
// revoke_permission
// =========================================================================

export const revokePermissionSchema = z.object({
  file_id: z.string().min(1).describe('Drive file or folder ID.'),
  permission_id: z.string().min(1).describe('Permission ID to revoke. Use list_permissions to find IDs.'),
  force_revoke_self: z.boolean().default(false).describe('If the permission belongs to the authenticated user, this defaults to false and the call is refused (self-lockout protection). Pass true to override.'),
});

export type RevokePermissionInput = z.infer<typeof revokePermissionSchema>;

export async function revokePermission(input: RevokePermissionInput): Promise<{
  file_id: string;
  permission_id: string;
  revoked: true;
}> {
  assertRateLimit('revoke_permission');
  if (!input.force_revoke_self) {
    const isSelf = await permissionBelongsToSelf(input.file_id, input.permission_id);
    if (isSelf) {
      throw new Error('Refusing to revoke your own access to file ' + input.file_id + '. Pass force_revoke_self=true to override (you may lose access to the file).');
    }
  }
  log('info', 'destructive_op', { tool: 'revoke_permission', file_id: input.file_id, permission_id: input.permission_id });
  const { drive } = await getGoogleClients();
  await drive.permissions.delete({
    fileId: input.file_id,
    permissionId: input.permission_id,
    supportsAllDrives: true,
  });
  return {
    file_id: input.file_id,
    permission_id: input.permission_id,
    revoked: true,
  };
}

// =========================================================================
// create_share_link
// =========================================================================

export const createShareLinkSchema = z.object({
  file_id: z.string().min(1).describe('Drive file or folder ID.'),
  role: z.enum(['reader', 'commenter', 'writer']).default('reader').describe('Access role for anyone with the link. Default "reader" (view-only).'),
  allow_discovery: z.boolean().default(false).describe('If true, the file becomes searchable on the public web. Default false (link-only access).'),
});

export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;

export async function createShareLink(input: CreateShareLinkInput): Promise<{
  file_id: string;
  share_link: string;
  permission_id: string;
  role: string;
}> {
  const { drive } = await getGoogleClients();

  if (!publicSharingAllowed()) {
    throw new Error('Public sharing is disabled by ALLOW_PUBLIC_SHARING=false env var. Cannot create share link.');
  }
  assertRateLimit('create_share_link');
  log('info', 'destructive_op', { tool: 'create_share_link', exposure: 'public', file_id: input.file_id, role: input.role, allow_discovery: input.allow_discovery });
  const permission = await drive.permissions.create({
    fileId: input.file_id,
    requestBody: {
      type: 'anyone',
      role: input.role,
      allowFileDiscovery: input.allow_discovery,
    },
    fields: 'id',
    supportsAllDrives: true,
  });

  const meta = await drive.files.get({
    fileId: input.file_id,
    fields: 'webViewLink',
    supportsAllDrives: true,
  });

  return {
    file_id: input.file_id,
    share_link: meta.data.webViewLink ?? '',
    permission_id: permission.data.id ?? '',
    role: input.role,
  };
}
