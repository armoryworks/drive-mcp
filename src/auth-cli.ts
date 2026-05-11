#!/usr/bin/env node
/**
 * One-time OAuth setup CLI.
 *
 * Run via: `npx @armoryworks/drive-mcp auth` or `npm run auth`.
 *
 * Flow:
 *   1. Read the OAuth client config from ~/.armoryworks/drive-mcp/credentials.json
 *   2. Spin up a localhost HTTP listener on a fixed port (default 8765)
 *   3. Print the Google consent URL and (best-effort) open it in the user's browser
 *   4. Receive the redirect after consent; extract the auth code
 *   5. Exchange the code for refresh + access tokens
 *   6. Persist tokens to ~/.armoryworks/drive-mcp/tokens.json
 *   7. Shut down the listener and exit
 *
 * After completion, the main MCP server can read the persisted tokens and run
 * unattended. Refresh tokens last indefinitely under normal conditions; if
 * the user revokes the wrapper's access at https://myaccount.google.com/permissions
 * they re-run this CLI to re-authenticate.
 */

import { createServer } from 'node:http';
import open from 'open';
import { OAuth2Client } from 'google-auth-library';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

import { SCOPES, getCredentialsPath, getTokensPath, saveTokens } from './auth.js';

const DEFAULT_PORT = 8765;

interface OAuthInstalledConfig {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
}

async function main(): Promise<void> {
  const port = Number(process.env['ARMORYWORKS_DRIVE_MCP_OAUTH_PORT'] ?? DEFAULT_PORT);
  const credentialsPath = getCredentialsPath();
  const tokensPath = getTokensPath();

  console.log(`Armory Works Drive MCP — OAuth setup`);
  console.log(``);
  console.log(`Credentials file: ${credentialsPath}`);
  console.log(`Tokens file:      ${tokensPath}`);
  console.log(``);

  // Load and validate credentials.
  let installed: OAuthInstalledConfig;
  try {
    const raw = await fs.readFile(credentialsPath, 'utf-8');
    const parsed = JSON.parse(raw) as { installed?: OAuthInstalledConfig };
    if (!parsed.installed) {
      console.error(`ERROR: Credentials file does not contain "installed" config.`);
      console.error(`Ensure the OAuth client is of type "Desktop application" in Google Cloud Console.`);
      process.exit(1);
    }
    installed = parsed.installed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`ERROR: Credentials file not found at ${credentialsPath}.`);
      console.error(``);
      console.error(`First-time setup:`);
      console.error(`  1. Visit https://console.cloud.google.com/apis/credentials`);
      console.error(`  2. Create OAuth 2.0 credentials of type "Desktop application"`);
      console.error(`  3. Download the JSON file`);
      console.error(`  4. Save it as ${credentialsPath}`);
      console.error(`  5. Run this command again`);
      console.error(``);
      console.error(`See docs/oauth-setup.md for complete instructions.`);
      process.exit(1);
    }
    throw err;
  }

  // Ensure tokens directory exists before we try to write to it.
  await fs.mkdir(dirname(tokensPath), { recursive: true });

  const redirectUri = `http://localhost:${port}/oauth/callback`;
  const client = new OAuth2Client({
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
    redirectUri,
  });

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: [...SCOPES],
    prompt: 'consent', // forces refresh_token issuance even on re-auth
  });

  // Listen for the OAuth callback.
  const codePromise = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>OAuth error</h1><p>${escapeHtml(error)}</p><p>You may close this window.</p>`);
        server.close();
        reject(new Error(`OAuth flow returned error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>OAuth error</h1><p>No authorization code in callback.</p>`);
        server.close();
        reject(new Error('No authorization code in callback'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><title>Auth complete</title></head><body style="font-family:system-ui;padding:40px;max-width:560px;margin:auto"><h1>Auth complete</h1><p>You may close this window and return to the terminal.</p></body></html>`,
      );
      server.close();
      resolve(code);
    });

    server.on('error', (err) => {
      reject(err);
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`Listening for OAuth callback on http://localhost:${port}`);
      console.log(``);
      console.log(`Opening browser to:`);
      console.log(`  ${authUrl}`);
      console.log(``);
      console.log(`If the browser doesn't open automatically, paste the URL above into a browser manually.`);
      console.log(``);

      void open(authUrl).catch(() => {
        // Browser-open failure isn't fatal; user can paste the URL manually.
      });
    });
  });

  const code = await codePromise;
  console.log(`Authorization code received. Exchanging for tokens...`);

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    console.warn(`WARNING: Google did not issue a refresh token. The MCP will work for this session`);
    console.warn(`but will need to re-authenticate when the access token expires (typically 1 hour).`);
    console.warn(``);
    console.warn(`To force a refresh token: revoke this app's access at`);
    console.warn(`https://myaccount.google.com/permissions and run this command again.`);
  }

  await saveTokens(tokens);
  console.log(`Tokens saved to ${tokensPath}`);
  console.log(``);
  console.log(`Setup complete. The MCP server is now ready to use.`);
  console.log(`See README.md for instructions on wiring it into Claude Desktop.`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}

main().catch((err: unknown) => {
  console.error(`Setup failed:`, err);
  process.exit(1);
});
