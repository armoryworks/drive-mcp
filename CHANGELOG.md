# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-05-11

Major expansion from 13 tools to ~56, plus a meaningful safety pass. The MCP now covers the full Drive lifecycle — create, read, update, delete, restructure, share, export — and is no longer a complement to Google's official Drive MCP but a complete replacement.

### Added — Read

- `get_document` — full Doc text + paragraph structure + indices + optional inline style runs. Single biggest leverage tool in v0.2.0; eliminates the "I'm guessing what's in the doc" loop that plagued v0.1.x.
- `get_spreadsheet` — Sheet metadata (tab IDs, titles, row/column counts) + optional cell values.
- `get_file_metadata` — owner, size, mime, parents, sharing state, web links.

### Added — Drive creation + organization

- `create_folder` — eliminates the create-at-root-then-move workflow.
- `create_doc` — create a Doc with optional initial content.
- `create_sheet` — create a Sheets spreadsheet with a named first tab.
- `copy_file` — bundled copy + rename + target folder in one call.
- `search_files` — Drive search by name/full-text/mime/parent/modification time or raw query.

### Added — Doc structural editing

- `apply_paragraph_style` — Heading 1/2/3, alignment, indent, line spacing.
- `delete_paragraph` — removes a whole paragraph cleanly (including the trailing newline, no blank line left behind).
- `insert_table` + `update_table_cell` — tables and per-cell content.
- `insert_image` — embed an image from a URL.
- `apply_list_style` — promote to bulleted or numbered list.

### Added — Sheet tabs + ranges

- `add_sheet` / `delete_sheet` / `rename_sheet` — tab management.
- `format_range` — bold/color/alignment/number-format/borders on a range.
- `delete_rows` / `delete_columns` / `insert_rows` / `insert_columns` — structural row/column ops.
- `create_chart` — native chart objects from a data range.
- `add_data_validation` — dropdown lists, number ranges, custom-formula validation.

### Added — Permissions

- `share_file` — share with user/group/domain/anyone at a specific role.
- `list_permissions` — list the ACL on a file.
- `revoke_permission` — revoke a permission by ID.
- `create_share_link` — generate a public anyone-with-link URL.

### Added — Batch

- `batch_doc_update` — bundle multiple Doc edits into one atomic batchUpdate call.
- `batch_sheet_update` — bundle multiple Sheet edits (values + structural ops grouped).
- `batch_move` — move many files in one call. Supports `dry_run`.
- `batch_delete` — delete many files in one call. Supports `dry_run` and `confirm_permanent`.

### Added — Comments

- `add_comment` / `list_comments` / `resolve_comment` — comment workflows.
- `accept_all_suggestions` / `reject_all_suggestions` — registered as tools but currently surface a structured error; the Docs API does not support bulk accept/reject. May be implemented properly in v0.3.0 by iterating individual suggestionIds.

### Added — Exports

- `export_to_pdf` — Doc/Sheet/Slide to PDF (base64 bytes).
- `export_to_docx` — Doc to Microsoft Word.
- `export_to_xlsx` — Sheet to Microsoft Excel.
- `get_thumbnail` — thumbnail link (short-lived).

### Added — Safety guardrails

- Two-axis confirmation for permanent delete: `delete_file` and `batch_delete` require both `permanent: true` AND `confirm_permanent: true`. Setting only `permanent: true` falls back to Trash with a warning.
- `batch_delete` capped at 20 file IDs when `permanent: true` (otherwise 100).
- `revoke_permission` self-lockout protection: refuses to revoke your own access unless `force_revoke_self: true`.
- `dry_run` mode on `batch_move`, `batch_delete`, `find_and_replace`, `find_and_replace_in_sheet`.
- Per-minute rate limits on the highest-risk tools (batch_delete, delete_file, revoke_permission, share_file, create_share_link).
- Audit logging at `info` level for every destructive op. Set `LOG_LEVEL=info` for the full audit trail.
- `ALLOW_PUBLIC_SHARING=false` env var disables anyone-with-link sharing entirely.
- `PROTECTED_FOLDER_IDS=X,Y,Z` env var refuses destructive ops on files inside listed folders.
- `[DESTRUCTIVE]` / `[EXPOSES DATA]` callouts in tool descriptions so the LLM sees risk markers before deciding to call.

### Added — Infrastructure

- Auto-retry on transient errors (5xx, 429) with exponential backoff + 25% jitter.
- Structured stderr logging gated by `LOG_LEVEL` env var.
- Friendlier error messages: common Google API errors now include actionable hints ("Folder requires owner action: try creating in root then moving").
- `ROADMAP.md` documenting v0.2.0 scope and planned v0.3.0 work.

### Changed

- Bumped the version to 0.2.0.
- Restructured tool registration in `src/index.ts` to accommodate the larger inventory.
- Expanded README with full v0.2.0 tool inventory and a "Safety considerations" section.

## [0.1.1] — 2026-05-11

### Fixed

- Added `drive-mcp` and `drive-mcp-auth` bin aliases so `npx -y @armoryworks/drive-mcp` resolves without a `-p` flag.
- Added `publishConfig.access = "public"` so future publishes default to public (resolves the v0.1.0 404-because-private issue).

## [0.1.0] — 2026-05-10

Initial release. Thirteen tools across Drive, Docs, and Sheets.

### Added

- **Drive**: `move_file`, `rename_file`, `delete_file`, `restore_file`, `list_folder`
- **Docs**: `find_and_replace`, `append_to_doc`, `insert_at_heading`, `apply_text_style`
- **Sheets**: `append_row`, `update_cell`, `update_range`, `find_and_replace_in_sheet`
- One-time OAuth setup CLI (`npx @armoryworks/drive-mcp auth`) with local-listener consent flow.
- Token persistence at `~/.armoryworks/drive-mcp/tokens.json` with auto-refresh on expiry.
- Full README and OAuth-setup walkthrough.
