/**
 * Safety guardrails for destructive and data-exposing operations.
 *
 * These run in-process; they are advisory protection against agent
 * misbehavior (an LLM that goes off-rails) and accidental misuse (a hand
 * caller who skipped reading the docs). They are NOT a security boundary
 * against a malicious actor with the user's OAuth tokens — that's outside
 * this MCP's threat model.
 *
 * Environment variables (read once at module load):
 *   ALLOW_PUBLIC_SHARING — "false" disables anyone-with-link sharing entirely.
 *                          Anything else (default unset) leaves it enabled.
 *   PROTECTED_FOLDER_IDS — comma-separated Drive folder IDs (or "root") that
 *                          reject destructive ops. Example: "root,X1Y2Z3".
 *                          Default empty.
 */

import { getGoogleClients } from '../google.js';

const ALLOW_PUBLIC_SHARING_DEFAULT = (process.env['ALLOW_PUBLIC_SHARING'] ?? 'true').toLowerCase() !== 'false';

const PROTECTED_FOLDER_IDS: ReadonlySet<string> = new Set(
  (process.env['PROTECTED_FOLDER_IDS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

export function publicSharingAllowed(): boolean {
  return ALLOW_PUBLIC_SHARING_DEFAULT;
}

export function isProtectedFolder(folderId: string): boolean {
  return PROTECTED_FOLDER_IDS.has(folderId);
}

export function assertNotProtectedFolder(folderId: string, operation: string): void {
  if (isProtectedFolder(folderId)) {
    throw new Error(
      'Operation "' + operation + '" blocked: folder ' + folderId +
      ' is in PROTECTED_FOLDER_IDS. Override by unsetting the env var or removing this ID from it.',
    );
  }
}

/**
 * Check that a file is not directly inside any protected folder. Used by
 * delete, share, move ops to prevent agent damage to designated-safe regions.
 */
export async function assertFileNotInProtectedFolder(
  fileId: string,
  operation: string,
): Promise<void> {
  if (PROTECTED_FOLDER_IDS.size === 0) return;
  const { drive } = await getGoogleClients();
  const meta = await drive.files.get({
    fileId,
    fields: 'parents',
    supportsAllDrives: true,
  });
  for (const parent of meta.data.parents ?? []) {
    if (PROTECTED_FOLDER_IDS.has(parent)) {
      throw new Error(
        'Operation "' + operation + '" blocked: file is inside protected folder ' + parent +
        '. Unset PROTECTED_FOLDER_IDS or move the file out first.',
      );
    }
  }
}

/**
 * Self-lockout protection: returns true if the given permission belongs to
 * the authenticated user (so revoking it would lock the caller out of the
 * file). Compares the permission's emailAddress against the auth user.
 */
export async function permissionBelongsToSelf(
  fileId: string,
  permissionId: string,
): Promise<boolean> {
  const { drive } = await getGoogleClients();
  const [perm, about] = await Promise.all([
    drive.permissions.get({
      fileId,
      permissionId,
      fields: 'emailAddress, type, role',
      supportsAllDrives: true,
    }),
    drive.about.get({ fields: 'user(emailAddress)' }),
  ]);
  const permEmail = (perm.data.emailAddress ?? '').toLowerCase();
  const userEmail = (about.data.user?.emailAddress ?? '').toLowerCase();
  return permEmail !== '' && permEmail === userEmail;
}

/**
 * Confirmation token store. Used by the two-call workflow for batch_delete
 * permanent. First call returns a short-lived token; second call must echo
 * it. Tokens live for 60 seconds in process memory; they don't survive a
 * restart of the MCP server (which is fine — restart is itself a circuit
 * breaker).
 */
const TOKEN_TTL_MS = 60_000;
const tokens = new Map<string, { expires: number; payload: string }>();

export function issueConfirmationToken(payload: string): string {
  const token = 'cnf_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  tokens.set(token, { expires: Date.now() + TOKEN_TTL_MS, payload });
  // Opportunistic cleanup of expired tokens.
  for (const [k, v] of tokens) {
    if (v.expires < Date.now()) tokens.delete(k);
  }
  return token;
}

export function consumeConfirmationToken(token: string, expectedPayload: string): boolean {
  const stored = tokens.get(token);
  if (!stored) return false;
  if (stored.expires < Date.now()) {
    tokens.delete(token);
    return false;
  }
  if (stored.payload !== expectedPayload) return false;
  tokens.delete(token);
  return true;
}

/**
 * Simple in-process rate limiter. Throws when a tool exceeds its per-minute
 * budget. Reset on server restart. Keeps "agent rampages through 500 files"
 * in check without preventing normal high-volume legitimate workflows.
 */
const PER_MINUTE_LIMITS: Record<string, number> = {
  batch_delete: 5,
  delete_file: 30,
  revoke_permission: 20,
  share_file: 50,
  create_share_link: 20,
};

const callWindows = new Map<string, { count: number; windowStart: number }>();

export function assertRateLimit(toolName: string): void {
  const limit = PER_MINUTE_LIMITS[toolName];
  if (!limit) return;
  const now = Date.now();
  let entry = callWindows.get(toolName);
  if (!entry || now - entry.windowStart > 60_000) {
    entry = { count: 0, windowStart: now };
    callWindows.set(toolName, entry);
  }
  entry.count++;
  if (entry.count > limit) {
    throw new Error(
      'Rate limit exceeded for tool "' + toolName + '": ' + limit +
      ' calls per minute. Wait ' + Math.ceil((60_000 - (now - entry.windowStart)) / 1000) +
      's before retrying. This limit protects against runaway agent loops.',
    );
  }
}
