/**
 * OAuth 2.0 authentication for the Google APIs.
 *
 * The wrapper has its own Google Cloud project, its own OAuth client of type
 * "Desktop application," and persists tokens locally. The user runs the auth
 * flow once via the {@link armoryworks-drive-mcp-auth} CLI; from then on the
 * MCP server reads the persisted tokens and refreshes them as needed.
 *
 * Token and credential storage:
 *   ~/.armoryworks/drive-mcp/credentials.json   (user-provided OAuth client config)
 *   ~/.armoryworks/drive-mcp/tokens.json        (refresh + access tokens; never commit)
 *
 * Overridable via ARMORYWORKS_DRIVE_MCP_HOME env var.
 */

import { OAuth2Client } from 'google-auth-library';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/**
 * OAuth scopes the wrapper requests. These are deliberately broad because
 * the operations we expose (delete, move, in-place edit, sheet writes) need
 * full read/write on Drive, Docs, and Sheets. There is no narrower set that
 * supports this functionality.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
] as const;

interface OAuthCredentialsFile {
  // Google Cloud Console downloads OAuth credentials in one of two shapes
  // depending on application type. We handle "installed" (Desktop) here.
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

export interface PersistedTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string;
  token_type?: string | null;
  expiry_date?: number | null;
  id_token?: string | null;
}

/** Returns the directory where credentials + tokens are stored. */
export function getHomeDir(): string {
  return process.env['ARMORYWORKS_DRIVE_MCP_HOME'] ?? join(homedir(), '.armoryworks', 'drive-mcp');
}

export function getCredentialsPath(): string {
  return join(getHomeDir(), 'credentials.json');
}

export function getTokensPath(): string {
  return join(getHomeDir(), 'tokens.json');
}

/** Loads the OAuth client config from disk. Throws a helpful error if missing. */
async function loadCredentials(): Promise<OAuthCredentialsFile> {
  const path = getCredentialsPath();
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw) as OAuthCredentialsFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `OAuth credentials file not found at ${path}. ` +
          `Download a "Desktop application" OAuth 2.0 client config from ` +
          `https://console.cloud.google.com/apis/credentials and save it there. ` +
          `See docs/oauth-setup.md for full instructions.`,
      );
    }
    throw err;
  }
}

/** Loads persisted tokens from disk if they exist; returns null otherwise. */
async function loadTokens(): Promise<PersistedTokens | null> {
  const path = getTokensPath();
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw) as PersistedTokens;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/** Persists tokens to disk. Creates parent dirs as needed. */
export async function saveTokens(tokens: PersistedTokens): Promise<void> {
  const path = getTokensPath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

/**
 * Constructs an OAuth2Client populated with the stored credentials and (if
 * available) the persisted tokens. The client will auto-refresh expired
 * access tokens using the refresh token; we listen for the 'tokens' event
 * and persist refreshed tokens back to disk so subsequent runs don't have
 * to repeat the refresh.
 */
export async function createAuthClient(): Promise<OAuth2Client> {
  const credentials = await loadCredentials();
  const installed = credentials.installed;
  if (!installed) {
    throw new Error(
      `Credentials file does not contain "installed" config. ` +
        `Ensure the OAuth client is of type "Desktop application" in Google Cloud Console.`,
    );
  }

  const redirectUri = installed.redirect_uris[0] ?? 'http://localhost:8765/oauth/callback';
  const client = new OAuth2Client({
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
    redirectUri,
  });

  const tokens = await loadTokens();
  if (tokens) {
    client.setCredentials(tokens);
  }

  // Persist refreshed tokens so we don't lose them between runs.
  client.on('tokens', (newTokens) => {
    void (async () => {
      const merged: PersistedTokens = { ...tokens, ...newTokens };
      try {
        await saveTokens(merged);
      } catch {
        // Persistence failures shouldn't crash the server; the new tokens
        // are still usable for this process's lifetime.
      }
    })();
  });

  return client;
}

/**
 * Returns true if persisted tokens exist and contain a refresh token. Used
 * by the MCP server at startup to fail fast with a helpful message rather
 * than letting the first tool call surface a cryptic authentication error.
 */
export async function hasValidAuth(): Promise<boolean> {
  const tokens = await loadTokens();
  return tokens !== null && typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0;
}
