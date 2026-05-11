/**
 * Thin singleton wrapper around the googleapis client.
 *
 * Each call site does:
 *   const { drive, docs, sheets } = await getGoogleClients();
 *
 * The first call constructs the OAuth2 client and instantiates the API
 * clients; subsequent calls return the same instances. The auth client
 * auto-refreshes tokens when they expire, so we don't need to think about
 * refresh at the call site.
 */

import { google } from 'googleapis';
import type { drive_v3, docs_v1, sheets_v4 } from 'googleapis';
import { createAuthClient } from './auth.js';

interface GoogleClients {
  drive: drive_v3.Drive;
  docs: docs_v1.Docs;
  sheets: sheets_v4.Sheets;
}

let cachedClients: GoogleClients | null = null;

export async function getGoogleClients(): Promise<GoogleClients> {
  if (cachedClients) return cachedClients;

  const auth = await createAuthClient();
  cachedClients = {
    drive: google.drive({ version: 'v3', auth }),
    docs: google.docs({ version: 'v1', auth }),
    sheets: google.sheets({ version: 'v4', auth }),
  };
  return cachedClients;
}

/** Reset the cached clients. Used by tests; not typically needed in production. */
export function resetGoogleClients(): void {
  cachedClients = null;
}
