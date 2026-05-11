# @armoryworks/drive-mcp

An [MCP](https://modelcontextprotocol.io/) server that exposes the Google Drive, Docs, and Sheets **write operations** that Google's official Drive MCP doesn't.

The official `Google Drive` MCP supports read + create only. This wrapper fills the gap with **move, rename, delete, restore, in-place find-and-replace, append, insert-at-heading, text styling, and sheet cell/row updates** — the operations that turn an AI agent from "creator of new content" into "manager of existing content."

Built by [Armory Works Technology, LLC](https://armoryworks.com) for use with [Forge](https://forge.armoryworks.com) and adopted internally for organizing the firm's own Google Workspace. MIT licensed; reuse freely.

## Tools

### Drive

| Tool | What it does |
|---|---|
| `move_file` | Change a file's parent folder. The fix for "I have duplicates at root that should be in folders." |
| `rename_file` | Change a file's title without affecting its content or ID. |
| `delete_file` | Trash (default) or permanently delete a file. The fix for "I can't delete via the official MCP." |
| `restore_file` | Restore a trashed file. |
| `list_folder` | List a folder's contents, sorted folders-first then alphabetically. |

### Docs

| Tool | What it does |
|---|---|
| `find_and_replace` | Sweep a Google Doc replacing one string with another. |
| `append_to_doc` | Append text to the end of a doc — ideal for log entries, journals, running notes. |
| `insert_at_heading` | Insert content after (or before) a specific heading by text match. |
| `apply_text_style` | Bold/italic/underline/font-size/color on every occurrence of given text. |

### Sheets

| Tool | What it does |
|---|---|
| `append_row` | Append a row to the bottom of a sheet tab. |
| `update_cell` | Set a single cell's value. |
| `update_range` | Set a 2D range of cells in one call. |
| `find_and_replace_in_sheet` | Sheet-wide or whole-spreadsheet find-and-replace. |

## Quick start

### 1. Install

```bash
npm install -g @armoryworks/drive-mcp
```

Or use `npx` without installing globally — Claude Desktop will spawn the binary on demand if you point at it via `npx`.

### 2. One-time OAuth setup

You need to create your own Google Cloud project and OAuth credentials. This is a Google requirement for any third-party app that reads/writes Drive content; it ensures *your* tokens are scoped to *your* control.

```bash
npx @armoryworks/drive-mcp auth
```

The first run will tell you exactly where to put your `credentials.json` and walk you through the consent flow. Tokens are saved to `~/.armoryworks/drive-mcp/tokens.json` and refresh automatically. See [docs/oauth-setup.md](./docs/oauth-setup.md) for the full step-by-step.

### 3. Wire into Claude Desktop

Add to your `claude_desktop_config.json` (Settings → Developer → Edit Config in Claude Desktop):

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

Restart Claude Desktop. The tools will appear in any new conversation.

## Security and trust model

This wrapper requests **full read/write access** to your Drive, Docs, and Sheets. There is no narrower scope set that supports the operations exposed; Google's scope granularity puts "list files" and "delete file" on the same drive-wide scope.

The implications:

- **Single-user.** Designed for one person to install on their own machine using their own Google account. Not a multi-tenant service.
- **Your tokens, your machine.** OAuth tokens are stored in `~/.armoryworks/drive-mcp/tokens.json` with mode `0600`. They never leave your machine.
- **Your Google Cloud project.** You create the OAuth client; you control it. Revoke anytime at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- **No telemetry.** This package does not phone home. Network traffic goes to `googleapis.com` only.

If you're not comfortable granting full-Drive access, this wrapper isn't for you — but neither is any other MCP that can write to Drive.

## Development

```bash
git clone https://github.com/armoryworks/drive-mcp.git
cd drive-mcp
npm install
npm run build
npm run auth          # one-time OAuth setup
npm test              # run the test suite
```

The codebase is small (~1,000 lines TypeScript). Tools are grouped by Google product under `src/tools/`. The MCP server wiring is in `src/index.ts`. Everything is ESM, Node 20+, strict TypeScript.

## License

MIT — see [LICENSE](./LICENSE).

## Why this exists

Google ships an official Drive MCP that is intentionally conservative: read + create only, no destructive operations. That's a defensible default for a public service, but it means an AI agent helping you organize your Drive can create folders and copy files but can't delete the duplicates it created or move them into the right home. The "trail of orphans at root" problem.

This MCP closes that gap for users who want their AI assistant to actually manage Drive content, not just produce it. Built for our own dog-fooding, published in case it's useful to anyone else.

— [Armory Works](https://armoryworks.com)
