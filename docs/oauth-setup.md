# OAuth setup — first-time walkthrough

A complete walkthrough for setting up the Google Cloud project and OAuth credentials this MCP needs. Takes ~15 minutes the first time, ~2 minutes if you've done it before.

## Why you have to do this yourself

Google's OAuth model requires every third-party app that accesses Drive to have its own OAuth client, registered to a Google Cloud project. For a published-to-everyone SaaS, the vendor creates one client and gets it verified by Google so users only see a normal consent screen. For a personal-use MCP like this one, the *user* creates the client and stays in "testing mode" — no verification needed, but you have to do the one-time setup.

The tradeoff: 15 minutes of setup, but the tokens are entirely under your control, the client lives in your own Google Cloud project, and revocation is one click in your Google account settings.

## Step 1 — Create a Google Cloud project

1. Open [console.cloud.google.com](https://console.cloud.google.com/)
2. At the top, click the project picker (next to the "Google Cloud" logo)
3. Click **NEW PROJECT** (top right of the picker dialog)
4. Project name: anything you like — suggestion: `armoryworks-drive-mcp`
5. Click **CREATE**, wait ~30 seconds, then select the project from the top picker

## Step 2 — Enable the three APIs

1. In the left sidebar nav, go to **APIs & Services → Library**
2. Search for **Google Drive API**, click it, click **ENABLE**
3. Search for **Google Docs API**, click it, click **ENABLE**
4. Search for **Google Sheets API**, click it, click **ENABLE**

Each enable takes ~5 seconds.

## Step 3 — Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen** in the sidebar
2. **User Type**: select **External** if your Google account is a personal Gmail; select **Internal** if you're using a Workspace account and only need access for that Workspace's users. (Internal is simpler if you have it.)
3. Click **CREATE**
4. **App information**:
   - App name: `Armory Works Drive MCP` (or whatever you want; only you'll see it)
   - User support email: your email
   - Developer contact email: your email
5. Click **SAVE AND CONTINUE**
6. **Scopes**: skip — click **SAVE AND CONTINUE** without adding any. The MCP will request its scopes at runtime.
7. **Test users** (only if you picked "External"): click **ADD USERS**, add the Google account you'll be signing in with. **Save and continue.**
8. Review the summary, click **BACK TO DASHBOARD**.

## Step 4 — Create OAuth credentials

1. **APIs & Services → Credentials** in the sidebar
2. Click **+ CREATE CREDENTIALS** at the top, choose **OAuth client ID**
3. **Application type**: **Desktop application** (this is important — Web and other types won't work with this MCP)
4. **Name**: `armoryworks-drive-mcp` (or anything)
5. Click **CREATE**
6. A dialog appears with your client ID and secret — click **DOWNLOAD JSON**
7. Save the file. We'll move it in the next step.

## Step 5 — Place the credentials file

The MCP looks for the credentials at `~/.armoryworks/drive-mcp/credentials.json` by default.

**macOS / Linux:**
```bash
mkdir -p ~/.armoryworks/drive-mcp
mv ~/Downloads/client_secret_*.json ~/.armoryworks/drive-mcp/credentials.json
```

**Windows (PowerShell):**
```powershell
New-Item -ItemType Directory -Force "$HOME\.armoryworks\drive-mcp" | Out-Null
Move-Item "$HOME\Downloads\client_secret_*.json" "$HOME\.armoryworks\drive-mcp\credentials.json"
```

(Adjust the source path if your browser saves downloads somewhere other than `~/Downloads`.)

## Step 6 — Run the auth flow

```bash
npx @armoryworks/drive-mcp auth
```

The CLI will:

1. Read your credentials file
2. Start a local listener on `http://localhost:8765`
3. Open your browser to Google's consent page
4. Wait for you to consent
5. Receive the redirect, exchange the code for tokens
6. Save tokens to `~/.armoryworks/drive-mcp/tokens.json`

If your account picker shows multiple Google accounts, pick the one you want the MCP to use.

If you see a warning that reads **"Google hasn't verified this app"**, click **Advanced** → **Go to Armory Works Drive MCP (unsafe)**. The "unverified" warning is expected for personal-use OAuth clients in testing mode and applies even to your own credentials accessing your own data. You're consenting to give the wrapper access to your own Drive.

## Step 7 — Wire into Claude Desktop

Edit your Claude Desktop config:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add the `armoryworks-drive` entry to `mcpServers`:

```json
{
  "mcpServers": {
    "armoryworks-drive": {
      "command": "npx",
      "args": ["-y", "@armoryworks/drive-mcp"]
    }
  }
}
```

Save the file and **completely quit and restart Claude Desktop** (not just close the window; the MCP server processes are spawned at startup).

In a new conversation, you should see the 13 tools (`move_file`, `delete_file`, etc.) available.

## Troubleshooting

**"OAuth credentials file not found"** — Step 5 didn't land the file in the right spot. Confirm the path: it should be exactly `~/.armoryworks/drive-mcp/credentials.json` (lowercase, hyphens not underscores).

**"redirect_uri_mismatch" during consent** — The OAuth client wasn't created as Desktop application type. Delete the credentials in Google Cloud Console and recreate them as **Desktop application** (Step 4).

**"This app isn't verified" warning** — Expected. Click Advanced → Go to ... (unsafe). You're authenticating to your own OAuth client; the warning is generic.

**Tokens stop working after a week** — If you skipped Step 3's test-users registration (External consent, Testing publishing status), Google expires unverified tokens after 7 days. Re-run `npx @armoryworks/drive-mcp auth` to refresh, or add yourself to the test-users list in the OAuth consent screen config to extend.

**MCP doesn't appear in Claude after restart** — Check Claude Desktop's logs (Settings → Developer → Open Logs Folder). Common issues: typo in the JSON config, npm/npx not on PATH for the Claude process, Node version below 20.

**Need to revoke access** — Go to [myaccount.google.com/permissions](https://myaccount.google.com/permissions), find "Armory Works Drive MCP" in your authorized apps, click Remove access. Then delete `~/.armoryworks/drive-mcp/tokens.json` to force a fresh auth on next run.
