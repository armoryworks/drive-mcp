/**
 * Safety guardrails for destructive and data-exposing operations.
 *
 * Philosophy: fail closed. Dangerous defaults (public sharing, accepting
 * arbitrary image URLs, no body-size limits) require explicit opt-in via
 * env var. The MCP runs safe by default; the user has to deliberately
 * loosen each control.
 *
 * Environment variables (read once at module load):
 *
 *   READ_ONLY                          "true" disables all write/destructive ops.
 *                                       Default: not set (writes allowed).
 *   ALLOW_PUBLIC_SHARING               "true" enables anyone-with-link sharing.
 *                                       Default: false (blocked). FAIL-CLOSED.
 *   PROTECTED_FOLDER_IDS               Comma-separated folder IDs; destructive
 *                                       ops on files inside are refused.
 *                                       Default: empty.
 *   LOCKED_FILE_IDS                    Comma-separated file IDs that may not
 *                                       be modified or deleted in any session.
 *                                       Default: empty.
 *   INSERT_IMAGE_ALLOWED_HOSTS         Comma-separated host allowlist for
 *                                       insert_image URLs. Special value "*"
 *                                       means allow all. Default: drive.google.com,
 *                                       lh3.googleusercontent.com,googleusercontent.com.
 *                                       FAIL-CLOSED — any unset host is blocked.
 *   INSERT_IMAGE_REQUIRE_HTTPS         "false" allows http:// image URLs.
 *                                       Default: true (https only). FAIL-CLOSED.
 *   MAX_INSERT_BYTES                   Per-call cap on text inserted by
 *                                       append/insert/initial_content paths.
 *                                       Default: 262144 (256 KiB).
 *   MAX_DESTRUCTIVE_OPS_PER_SESSION    Hard cap on destructive ops per process
 *                                       lifetime. Default: 500.
 *   PER_DOC_OPS_PER_MINUTE             Per-document modification rate.
 *                                       Default: 60.
 *   BACKUP_BEFORE_DESTRUCTIVE          "false" disables auto-snapshot before
 *                                       destructive content edits. Default true.
 *                                       FAIL-CLOSED.
 *   AUDIT_WEBHOOK_URL                  Optional URL receiving JSON audit lines
 *                                       for every destructive op. Default: unset.
 *   DRY_RUN_ALL                        "true" forces every destructive op into
 *                                       dry-run mode. Default: false.
 *   REPLAY_WINDOW_MS                   Window for replay detection (identical
 *                                       tool+args refused within window).
 *                                       Default: 2000.
 */

import { getGoogleClients } from '../google.js';
import { log } from './retry.js';
import { createHash } from 'node:crypto';

// ---------- env var parsing ----------

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return raw.toLowerCase() === 'true';
}

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  return isNaN(n) ? defaultValue : n;
}

function envCsv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ALL settings read once at module load and frozen.

const READ_ONLY = envBool('READ_ONLY', false);
const ALLOW_PUBLIC_SHARING = envBool('ALLOW_PUBLIC_SHARING', false);  // FAIL-CLOSED default
const PROTECTED_FOLDER_IDS: ReadonlySet<string> = new Set(envCsv('PROTECTED_FOLDER_IDS'));
const LOCKED_FILE_IDS: ReadonlySet<string> = new Set(envCsv('LOCKED_FILE_IDS'));
const INSERT_IMAGE_REQUIRE_HTTPS = envBool('INSERT_IMAGE_REQUIRE_HTTPS', true);  // FAIL-CLOSED default
const MAX_INSERT_BYTES = envInt('MAX_INSERT_BYTES', 262144);
const MAX_DESTRUCTIVE_OPS_PER_SESSION = envInt('MAX_DESTRUCTIVE_OPS_PER_SESSION', 500);
const PER_DOC_OPS_PER_MINUTE = envInt('PER_DOC_OPS_PER_MINUTE', 60);
const BACKUP_BEFORE_DESTRUCTIVE = envBool('BACKUP_BEFORE_DESTRUCTIVE', true);  // FAIL-CLOSED default
const AUDIT_WEBHOOK_URL = process.env['AUDIT_WEBHOOK_URL'];
const DRY_RUN_ALL = envBool('DRY_RUN_ALL', false);
const REPLAY_WINDOW_MS = envInt('REPLAY_WINDOW_MS', 2000);

const INSERT_IMAGE_ALLOWED_HOSTS_RAW = envCsv('INSERT_IMAGE_ALLOWED_HOSTS');
const INSERT_IMAGE_ALLOW_ALL = INSERT_IMAGE_ALLOWED_HOSTS_RAW.includes('*');
const INSERT_IMAGE_ALLOWED_HOSTS: ReadonlySet<string> = new Set(
  INSERT_IMAGE_ALLOWED_HOSTS_RAW.length > 0
    ? INSERT_IMAGE_ALLOWED_HOSTS_RAW
    : ['drive.google.com', 'lh3.googleusercontent.com', 'googleusercontent.com'],
);

// ---------- public exports ----------

export function isReadOnly(): boolean {
  return READ_ONLY;
}

export function isDryRunAll(): boolean {
  return DRY_RUN_ALL;
}

export function publicSharingAllowed(): boolean {
  return ALLOW_PUBLIC_SHARING;
}

export function isProtectedFolder(folderId: string): boolean {
  return PROTECTED_FOLDER_IDS.has(folderId);
}

export function isLockedFile(fileId: string): boolean {
  return LOCKED_FILE_IDS.has(fileId);
}

export function assertWriteEnabled(toolName: string): void {
  if (READ_ONLY) {
    throw new Error(
      'Operation "' + toolName + '" blocked: READ_ONLY mode is enabled. Unset the READ_ONLY env var to allow writes.',
    );
  }
}

export function assertNotLocked(fileId: string, toolName: string): void {
  if (LOCKED_FILE_IDS.has(fileId)) {
    throw new Error(
      'Operation "' + toolName + '" blocked: file ' + fileId + ' is in LOCKED_FILE_IDS. Remove the ID from the env var to allow changes.',
    );
  }
}

export function assertNotProtectedFolder(folderId: string, operation: string): void {
  if (PROTECTED_FOLDER_IDS.has(folderId)) {
    throw new Error(
      'Operation "' + operation + '" blocked: folder ' + folderId + ' is in PROTECTED_FOLDER_IDS.',
    );
  }
}

export async function assertFileNotInProtectedFolder(
  fileId: string,
  operation: string,
): Promise<void> {
  if (PROTECTED_FOLDER_IDS.size === 0) return;
  const { drive } = await getGoogleClients();
  const meta = await drive.files.get({
    fileId, fields: 'parents', supportsAllDrives: true,
  });
  for (const parent of meta.data.parents ?? []) {
    if (PROTECTED_FOLDER_IDS.has(parent)) {
      throw new Error(
        'Operation "' + operation + '" blocked: file is inside protected folder ' + parent + '.',
      );
    }
  }
}

export function assertInsertSize(text: string, toolName: string): void {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_INSERT_BYTES) {
    throw new Error(
      'Operation "' + toolName + '" blocked: insert payload (' + bytes + ' bytes) exceeds MAX_INSERT_BYTES (' + MAX_INSERT_BYTES + '). Raise the env var or split the insert into smaller calls.',
    );
  }
}

export function assertImageUrlAllowed(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Image URL is not a valid URL: ' + url);
  }
  if (INSERT_IMAGE_REQUIRE_HTTPS && parsed.protocol !== 'https:') {
    throw new Error(
      'Image URL must use HTTPS (scheme was "' + parsed.protocol + '"). Set INSERT_IMAGE_REQUIRE_HTTPS=false to allow plain HTTP, though this is not recommended.',
    );
  }
  if (INSERT_IMAGE_ALLOW_ALL) return;
  const host = parsed.hostname.toLowerCase();
  for (const allowed of INSERT_IMAGE_ALLOWED_HOSTS) {
    if (host === allowed.toLowerCase() || host.endsWith('.' + allowed.toLowerCase())) return;
  }
  throw new Error(
    'Image host "' + host + '" not in INSERT_IMAGE_ALLOWED_HOSTS allowlist (' +
    [...INSERT_IMAGE_ALLOWED_HOSTS].join(', ') + '). Set INSERT_IMAGE_ALLOWED_HOSTS=* to allow all hosts.',
  );
}

export async function permissionBelongsToSelf(
  fileId: string,
  permissionId: string,
): Promise<boolean> {
  const { drive } = await getGoogleClients();
  const [perm, about] = await Promise.all([
    drive.permissions.get({
      fileId, permissionId,
      fields: 'emailAddress, type, role',
      supportsAllDrives: true,
    }),
    drive.about.get({ fields: 'user(emailAddress)' }),
  ]);
  const permEmail = (perm.data.emailAddress ?? '').toLowerCase();
  const userEmail = (about.data.user?.emailAddress ?? '').toLowerCase();
  return permEmail !== '' && permEmail === userEmail;
}

// ---------- confirmation token store ----------

const TOKEN_TTL_MS = 60_000;
const tokens = new Map<string, { expires: number; payload: string }>();

export function issueConfirmationToken(payload: string): string {
  const token = 'cnf_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  tokens.set(token, { expires: Date.now() + TOKEN_TTL_MS, payload });
  for (const [k, v] of tokens) if (v.expires < Date.now()) tokens.delete(k);
  return token;
}

export function consumeConfirmationToken(token: string, expectedPayload: string): boolean {
  const stored = tokens.get(token);
  if (!stored) return false;
  if (stored.expires < Date.now()) { tokens.delete(token); return false; }
  if (stored.payload !== expectedPayload) return false;
  tokens.delete(token);
  return true;
}

// ---------- per-tool rate limits ----------

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
      'Rate limit exceeded for tool "' + toolName + '": ' + limit + '/minute. Wait ' +
      Math.ceil((60_000 - (now - entry.windowStart)) / 1000) + 's.',
    );
  }
}

// ---------- per-document rate limit ----------

const perDocWindows = new Map<string, { count: number; windowStart: number }>();

export function assertPerDocRateLimit(fileId: string, toolName: string): void {
  const now = Date.now();
  let entry = perDocWindows.get(fileId);
  if (!entry || now - entry.windowStart > 60_000) {
    entry = { count: 0, windowStart: now };
    perDocWindows.set(fileId, entry);
  }
  entry.count++;
  if (entry.count > PER_DOC_OPS_PER_MINUTE) {
    throw new Error(
      'Per-document rate limit exceeded on ' + fileId + ' (' + PER_DOC_OPS_PER_MINUTE +
      '/minute) for tool ' + toolName + '. Likely an agent loop; investigate and retry after ' +
      Math.ceil((60_000 - (now - entry.windowStart)) / 1000) + 's.',
    );
  }
}

// ---------- session budget ----------

let destructiveOpsThisSession = 0;

export function assertSessionBudget(toolName: string): void {
  destructiveOpsThisSession++;
  if (destructiveOpsThisSession > MAX_DESTRUCTIVE_OPS_PER_SESSION) {
    throw new Error(
      'Session destructive-op budget exceeded (' + MAX_DESTRUCTIVE_OPS_PER_SESSION + '). Tool ' +
      toolName + ' refused. Restart the MCP server to reset, or raise MAX_DESTRUCTIVE_OPS_PER_SESSION.',
    );
  }
}

// ---------- replay detection ----------

const recentCalls = new Map<string, number>();

export function assertNotDuplicate(toolName: string, args: unknown): void {
  const sig = createHash('sha256').update(toolName + '|' + JSON.stringify(args)).digest('hex');
  const now = Date.now();
  const last = recentCalls.get(sig);
  if (last && now - last < REPLAY_WINDOW_MS) {
    throw new Error(
      'Duplicate call refused (replay detection): same args within ' + REPLAY_WINDOW_MS +
      'ms. Likely an agent loop. Wait ' + (REPLAY_WINDOW_MS - (now - last)) + 'ms and try again.',
    );
  }
  recentCalls.set(sig, now);
  // Cheap GC.
  if (recentCalls.size > 1000) {
    for (const [k, t] of recentCalls) {
      if (now - t > REPLAY_WINDOW_MS) recentCalls.delete(k);
    }
  }
}

// ---------- auto-backup ----------

let backupFolderId: string | null = null;

async function ensureBackupFolder(): Promise<string> {
  if (backupFolderId) return backupFolderId;
  const { drive } = await getGoogleClients();
  const existing = await drive.files.list({
    q: "name = '_drive-mcp-backups' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false",
    fields: 'files(id)',
    pageSize: 1,
  });
  if (existing.data.files && existing.data.files[0]?.id) {
    backupFolderId = existing.data.files[0].id;
    return backupFolderId;
  }
  const created = await drive.files.create({
    requestBody: {
      name: '_drive-mcp-backups',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root'],
    },
    fields: 'id',
  });
  backupFolderId = created.data.id ?? '';
  return backupFolderId;
}

/**
 * Take a backup copy of a Drive file before a destructive content edit.
 * Returns the backup file ID (empty string if BACKUP_BEFORE_DESTRUCTIVE=false).
 * Failures are logged but do not block the originating op — backups are
 * safety nets, not gates.
 */
export async function snapshotBeforeEdit(fileId: string, toolName: string): Promise<string> {
  if (!BACKUP_BEFORE_DESTRUCTIVE) return '';
  try {
    const { drive } = await getGoogleClients();
    const meta = await drive.files.get({
      fileId, fields: 'name', supportsAllDrives: true,
    });
    const backupName = (meta.data.name ?? 'untitled') + ' [backup ' + new Date().toISOString() + ' before ' + toolName + ']';
    const folderId = await ensureBackupFolder();
    const copied = await drive.files.copy({
      fileId,
      requestBody: { name: backupName, parents: [folderId] },
      fields: 'id',
      supportsAllDrives: true,
    });
    const backupId = copied.data.id ?? '';
    log('info', 'backup_created', { source_file_id: fileId, backup_file_id: backupId, tool: toolName });
    return backupId;
  } catch (err) {
    log('warn', 'backup_failed', {
      file_id: fileId, tool: toolName,
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

// ---------- audit webhook ----------

export async function emitAuditWebhook(event: Record<string, unknown>): Promise<void> {
  if (!AUDIT_WEBHOOK_URL) return;
  try {
    await fetch(AUDIT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ts: new Date().toISOString(), ...event }),
    });
  } catch (err) {
    log('warn', 'audit_webhook_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------- convenience composer ----------

/**
 * Standard pre-flight for any destructive op: bundles READ_ONLY check,
 * replay detection, and session-budget enforcement. Call at the top of every
 * write/delete/share tool handler.
 */
export function preflightDestructive(toolName: string, input: unknown): void {
  assertWriteEnabled(toolName);
  assertNotDuplicate(toolName, input);
  assertSessionBudget(toolName);
}

/**
 * Pre-flight for ops that target a specific file: adds locked-file and
 * per-document rate-limit checks on top of the standard destructive
 * pre-flight. Asynchronous because protected-folder check needs an API call.
 */
export async function preflightFileMutation(
  toolName: string,
  fileId: string,
  input: unknown,
): Promise<void> {
  preflightDestructive(toolName, input);
  assertNotLocked(fileId, toolName);
  assertPerDocRateLimit(fileId, toolName);
  await assertFileNotInProtectedFolder(fileId, toolName);
}
