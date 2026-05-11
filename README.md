# @armoryworks/drive-mcp

An [MCP](https://modelcontextprotocol.io/) server that gives AI agents full lifecycle control over Google Drive, Docs, and Sheets — create, read, update, delete, restructure, share, and export.

Built by [Armory Works Technology, LLC](https://armoryworks.com) for use with [Forge](https://forge.armoryworks.com) and adopted internally for organizing the firm's own Google Workspace. MIT licensed; reuse freely.

## What is this for

Google ships an official Drive MCP that is intentionally conservative: read + create only, no destructive operations, no in-place edits. That's defensible for a public default — but it means an AI agent helping you organize your Drive can create folders and copy files but can't delete the duplicates it created, fix metadata, restructure a document, or share work with collaborators.

This MCP closes that gap. After v0.2.0, it is a complete Drive toolkit: 56 tools spanning all the operations a working agent actually needs. The wrapper is single-user — designed for you to install on your own machine with your own OAuth credentials. It is not a multi-tenant service.

## Tools (v0.2.0)

### Read
| Tool | What it does |
|---|---|
| `get_document` | Read a Doc's paragraph structure + text + indices. **Use this before editing.** |
| `get_spreadsheet` | Read a Sheet's tabs + values + ranges. |
| `get_file_metadata` | Owner, size, mime, parents, sharing state for any file. |

### Drive
| Tool | What it does |
|---|---|
| `move_file` | Change a file's parent folder. |
| `rename_file` | Change a file's title (ID stable). |
| `delete_file` | Trash (default) or permanently delete (requires `confirm_permanent`). |
| `restore_file` | Restore a trashed file. |
| `list_folder` | List a folder's contents. |
| `create_folder` | Create a new folder inside a parent. |
| `create_doc` | Create a new Google Doc with optional initial content. |
| `create_sheet` | Create a new Sheets spreadsheet with a named first tab. |
| `copy_file` | Copy + optional rename + optional target folder in one call. |
| `search_files` | Search by name, full-text, mime type, parent, modification time, or raw query. |

### Docs
| Tool | What it does |
|---|---|
| `find_and_replace` | Sweep a Doc replacing one string with another. Supports `dry_run`. |
| `append_to_doc` | Append text to the end of a Doc. |
| `insert_at_heading` | Insert content at a specific anchor by exact text. |
| `apply_text_style` | Bold/italic/underline/color on every occurrence. |
| `apply_paragraph_style` | Heading 1/2/3, alignment, indent, line spacing on a paragraph. |
| `delete_paragraph` | Remove a whole paragraph cleanly (including its newline). |
| `insert_table` | Insert N×M empty table at an anchor. |
| `update_table_cell` | Set content of a specific (table, row, column). |
| `insert_image` | Embed an image from a URL at an anchor. |
| `apply_list_style` | Promote a paragraph to a bulleted or numbered list. |

### Sheets
| Tool | What it does |
|---|---|
| `append_row` | Append a row to the bottom of a tab. |
| `update_cell` | Set a single cell via A1 notation. |
| `update_range` | Set a 2D range of cells. |
| `find_and_replace_in_sheet` | Sheet-wide or whole-spreadsheet find-and-replace. Supports `dry_run`. |
| `add_sheet` / `delete_sheet` / `rename_sheet` | Tab management. |
| `format_range` | Bold/color/alignment/number-format on a range. |
| `delete_rows` / `delete_columns` / `insert_rows` / `insert_columns` | Structural row/column ops. |
| `create_chart` | Add a chart (column/bar/line/area/pie/scatter/combo/histogram) sourcing a range. |
| `add_data_validation` | Dropdown lists, number ranges, custom-formula validation. |

### Permissions
| Tool | What it does |
|---|---|
| `share_file` | Share with user/group/domain/anyone at a role. |
| `list_permissions` | List the ACL on a file. |
| `revoke_permission` | Revoke a permission by ID (self-lockout protected). |
| `create_share_link` | Generate a public anyone-with-link URL. |

### Batch
| Tool | What it does |
|---|---|
| `batch_doc_update` | Bundle multiple Doc edits into one atomic batchUpdate call. |
| `batch_sheet_update` | Bundle multiple Sheet edits (values + structural). |
| `batch_move` | Move many files in one call. Supports `dry_run`. |
| `batch_delete` | Delete many files in one call. Supports `dry_run`. Capped at 20 when permanent. |

### Comments / Review
| Tool | What it does |
|---|---|
| `add_comment` | Add a comment to a file. |
| `list_comments` | List comments (filter by resolved/deleted). |
| `resolve_comment` | Mark a comment resolved. |
| `accept_all_suggestions` / `reject_all_suggestions` | (Currently surface a structured error — the Docs API does not support bulk accept/reject; v0.3.0 may add iteration over individual suggestionIds.) |

### Exports
| Tool | What it does |
|---|---|
| `export_to_pdf` | Export a Doc/Sheet/Slide to PDF (base64 bytes). |
| `export_to_docx` | Export a Doc to Microsoft Word. |
| `export_to_xlsx` | Export a Sheet to Microsoft Excel. |
| `get_thumbnail` | Get a thumbnail link (short-lived). |

## Quick start

### 1. Install

```bash
npm install -g @armoryworks/drive-mcp
```

Or use `npx` without installing globally — Claude Desktop will spawn the binary on demand.

### 2. One-time OAuth setup

You need your own Google Cloud project and OAuth credentials. This is a Google requirement; it ensures *your* tokens are scoped to *your* control.

```bash
npx -y -p @armoryworks/drive-mcp armoryworks-drive-mcp-auth
```

The first run tells you exactly where to put your `credentials.json` and walks you through the consent flow. Tokens are saved to `~/.armoryworks/drive-mcp/tokens.json` (mode 0600) and refresh automatically. See [docs/oauth-setup.md](./docs/oauth-setup.md) for the full step-by-step.

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

On Windows the spawning may need a `cmd /c` wrapper:

```json
{
  "mcpServers": {
    "armoryworks-drive": {
      "command": "cmd.exe",
      "args": ["/c", "npx.cmd", "-y", "@armoryworks/drive-mcp"]
    }
  }
}
```

Restart Claude Desktop. The tools appear in any new conversation.

## Safety considerations

This MCP can move files to Trash, change permissions, and overwrite content. The threat model is **agent misbehavior or accidental misuse**, not a malicious actor — if someone has filesystem access to your machine, they already have your tokens.

**The MCP runs safe by default.** Dangerous capabilities (public sharing, arbitrary image URLs, large content inserts) require explicit opt-in via env var. You have to deliberately loosen each control.

### Always-on built-in protections (cannot be disabled)

- **No permanent deletion.** `delete_file` and `batch_delete` only Trash. The user recovers from Drive UI within 30 days. Permanent deletion is intentionally not exposed.
- **Self-lockout protection.** `revoke_permission` refuses to revoke your own access unless `force_revoke_self: true`.
- **Per-tool rate limits.** `batch_delete`: 5/min, `delete_file`: 30/min, `revoke_permission`: 20/min, `share_file`: 50/min, `create_share_link`: 20/min.
- **Per-document rate limit.** Any one file: 60 modifications/minute (configurable). Catches agent loops on a single doc.
- **Session destructive-op budget.** Hard cap of 500 destructive operations per server process (configurable). Forces restart for "this agent is doing a lot."
- **Replay detection.** Identical tool+args within 2s window are refused. Catches retry loops.
- **Body-size cap on inserts.** Text inserts capped at 256 KiB by default. Prevents content bombing.
- **Audit logging.** Every destructive op writes a structured stderr line (`LOG_LEVEL=info` for full audit). Optional `AUDIT_WEBHOOK_URL` posts the same events to a webhook.
- **Dry-run mode** on `batch_move`, `batch_delete`, `find_and_replace`, `find_and_replace_in_sheet`.

### Fail-closed defaults — set explicitly to loosen

| Env var | Default (safe) | What it controls |
|---|---|---|
| `ALLOW_PUBLIC_SHARING` | `false` (deny) | Set to `true` to allow `share_file` with `type=anyone` and `create_share_link`. |
| `INSERT_IMAGE_ALLOWED_HOSTS` | `drive.google.com,lh3.googleusercontent.com,googleusercontent.com` | Allowlist for `insert_image` URLs. Set `*` to allow any host (not recommended). |
| `INSERT_IMAGE_REQUIRE_HTTPS` | `true` (deny `http://`) | Set `false` to permit plain-HTTP image URLs. |
| `BACKUP_BEFORE_DESTRUCTIVE` | `true` (always backup) | Set `false` to skip automatic backups before destructive content edits. Backups land in `_drive-mcp-backups/` at your Drive root. |

### Opt-in tighter modes (default off — set to enable)

| Env var | Default | What it does |
|---|---|---|
| `READ_ONLY` | unset | Set `true` to disable ALL write/delete/share tools. Useful for exploration sessions. |
| `PROTECTED_FOLDER_IDS` | empty | Comma-separated folder IDs. Destructive ops on files inside are refused. |
| `LOCKED_FILE_IDS` | empty | Comma-separated file IDs. Cannot be modified or deleted. |
| `DRY_RUN_ALL` | `false` | Set `true` to force every destructive op into preview mode regardless of how invoked. |
| `AUDIT_WEBHOOK_URL` | unset | URL to POST audit events to in addition to stderr logging. |

### Tunable thresholds

| Env var | Default | What it tunes |
|---|---|---|
| `MAX_INSERT_BYTES` | `262144` (256 KiB) | Per-call cap on inserted text. |
| `MAX_DESTRUCTIVE_OPS_PER_SESSION` | `500` | Session budget for destructive ops. |
| `PER_DOC_OPS_PER_MINUTE` | `60` | Per-document modification rate. |
| `REPLAY_WINDOW_MS` | `2000` | Window for replay detection. |
| `LOG_LEVEL` | `warn` | `debug` / `info` / `warn` / `error` / `silent`. |

### Operational recommendations

- Keep a periodic Drive backup (Google Takeout or third-party). Drive Trash isn't a backup; 30 days isn't forever. `BACKUP_BEFORE_DESTRUCTIVE=true` (the default) snapshots files before edits but doesn't replace whole-drive backups.
- Use `dry_run: true` (or set `DRY_RUN_ALL=true` for the whole session) on bulk operations affecting more than a few files.
- Run with `LOG_LEVEL=info` for a complete record of destructive actions.
- For high-stakes work, run with `READ_ONLY=true` first to let the agent plan, then re-run without it once you've reviewed the plan.

## Configuration reference

| Env var | Default | Effect |
|---|---|---|
| `ARMORYWORKS_DRIVE_MCP_HOME` | `~/.armoryworks/drive-mcp` | Where credentials.json and tokens.json live. |
| `ALLOW_PUBLIC_SHARING` | unset (allows) | Set to `false` to block anyone-with-link sharing. |
| `PROTECTED_FOLDER_IDS` | unset (no protection) | Comma-separated Drive folder IDs; ops on files inside are refused. |
| `LOG_LEVEL` | `warn` | `debug` / `info` / `warn` / `error` / `silent`. |

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

The codebase is small (~3,000 lines TypeScript). Tools are grouped by Google product under `src/tools/`. The MCP server wiring is in `src/index.ts`. Everything is ESM, Node 20+, strict TypeScript.

## License

MIT — see [LICENSE](./LICENSE).

— [Armory Works](https://armoryworks.com)
