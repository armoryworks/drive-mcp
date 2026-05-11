# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] — Unreleased

Comprehensive safety pass: Tier A + B + C guardrails from the v0.2.0 roadmap, with **fail-closed defaults** on every dangerous capability. The MCP is now safe by default; the user must explicitly opt in to looser behavior via env var.

### Added — Always-on protections

- `READ_ONLY` env var. Set `true` to disable all write/delete/share tools.
- Body-size cap on text inserts. `append_to_doc`, `insert_at_heading`, `update_table_cell`, `create_doc` initial_content, and `update_cell`/`update_range` payloads are capped at 256 KiB by default (configurable via `MAX_INSERT_BYTES`).
- Per-document modification rate limit. Any single file can be modified at most 60 times per minute (configurable via `PER_DOC_OPS_PER_MINUTE`). Catches agent loops on one doc.
- Session destructive-op budget. Hard cap of 500 destructive operations per server process (configurable via `MAX_DESTRUCTIVE_OPS_PER_SESSION`).
- Replay detection. Identical tool+args within a 2-second window are refused (configurable via `REPLAY_WINDOW_MS`). Catches retry loops.
- `LOCKED_FILE_IDS` env var. Comma-separated file IDs that may never be modified or deleted in this session.
- Automatic backup before destructive content edits. `find_and_replace`, `delete_paragraph`, `batch_doc_update`, `find_and_replace_in_sheet`, `batch_sheet_update` snapshot the file to `_drive-mcp-backups/` before mutating. Controlled by `BACKUP_BEFORE_DESTRUCTIVE` (default `true` — fail-closed).
- `AUDIT_WEBHOOK_URL` env var. Posts the same structured audit events that go to stderr to an external URL.
- `DRY_RUN_ALL` env var. Forces every destructive op into preview mode regardless of how invoked.
- `preflightDestructive` and `preflightFileMutation` helpers in guards. Composed at the top of every destructive handler.

### Changed — Fail-closed defaults

- **`ALLOW_PUBLIC_SHARING` now defaults to `false`.** v0.2.1 defaulted to `true`. `share_file` with `type=anyone` and `create_share_link` are blocked unless explicitly enabled. **Migration:** if you previously relied on public sharing, set `ALLOW_PUBLIC_SHARING=true` in your env.
- `INSERT_IMAGE_ALLOWED_HOSTS` introduced with a Drive-only default allowlist (`drive.google.com`, `lh3.googleusercontent.com`, `googleusercontent.com`). Other hosts blocked. Set `INSERT_IMAGE_ALLOWED_HOSTS=*` to allow any host.
- `INSERT_IMAGE_REQUIRE_HTTPS` introduced, default `true`. Plain HTTP image URLs refused unless explicitly allowed.
- `BACKUP_BEFORE_DESTRUCTIVE` introduced, default `true`. Backups happen by default; opt out by setting `false`.

### Changed — Tool descriptions

- Several destructive tool descriptions now document the additional pre-flight checks they run.

## [0.2.1] — Unreleased

### Changed

- **Permanent deletion removed.** `delete_file` and `batch_delete` no longer accept `permanent` or `confirm_permanent` parameters. All deletions go to Drive Trash and are recoverable from the Drive UI for 30 days. Permanent deletion is now intentionally only available to the user, performed directly through the Drive interface — not exposed to agents or automated callers. Both tools now return a `recovery_message` describing the recovery path. Tool descriptions reframed from `[DESTRUCTIVE]` to `[REVERSIBLE]`. This is a deliberate safety tightening: the cost of an agent misbehaving and permanently deleting irreplaceable content is asymmetric to the convenience of a one-call permanent-delete API.

### Removed

- `delete_file` schema: removed `permanent` and `confirm_permanent` parameters.
- `batch_delete` schema: removed `permanent`, `confirm_permanent`, and the per-call cap of 20 (now uniformly 100). Removed `mode` from response (always trashed).

### Migration notes for v0.2.0 callers

Code that passed `permanent: true` no longer has any effect — those parameters are silently dropped by Zod. Behavior is unchanged for callers using the two-axis confirmation correctly (which already fell back to trash when `confirm_permanent` was missing); only the rare caller that passed both flags will see different behavior. Permanent deletion now requires the user to visit Drive Trash manually.

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
