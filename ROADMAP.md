# Roadmap

Status of work on `@armoryworks/drive-mcp`. This file is the canonical source of truth for what's done, in flight, and deferred. Individual changes land in [CHANGELOG.md](./CHANGELOG.md) per release.

## Philosophy

The wrapper exists because Google's official Drive MCP is read + create only — it can't help an AI agent *manage* Drive content (delete duplicates, fix metadata, rewrite content in place). v0.1.x scoped narrowly as a write-side gap-filler. v0.2.0 expands scope: the goal is a *complete* Drive operations toolkit so consumers don't need to compose this MCP with the official one to get full lifecycle coverage.

The line we hold: this is a single-user tool that runs on the user's machine using their OAuth tokens. It is not a hosted service, not multi-tenant, and not a Google Workspace integration platform.

## v0.2.0 — Complete Drive operations toolkit

**Goal:** Turn the MCP from a niche gap-filler into the primary Drive tool for AI agents, with full lifecycle coverage (create / read / update / delete) and the structural editing primitives needed for non-trivial content management.

### Tier 1 — closes pain encountered in v0.1.x usage (mandatory)

- [ ] `get_document` — full Doc text + paragraph structure + indices + style runs (single biggest leverage; eliminates "I'm guessing what's in the doc" loops)
- [ ] `get_spreadsheet` — Sheet tab names + values + ranges (counterpart to get_document)
- [ ] `get_file_metadata` — owner / size / mime / parents / sharing state / web links
- [ ] `apply_paragraph_style` — Heading 1/2/3/normal + alignment + indent + spacing (the "I can't promote a paragraph to a heading" gap)
- [ ] `delete_paragraph` — match a paragraph by exact text and remove it cleanly *including* its trailing newline
- [ ] `create_folder` — eliminates the create-at-root-then-move workflow
- [ ] `create_doc` / `create_sheet` — full lifecycle without depending on Google's official MCP
- [ ] `copy_file` — bundled copy + rename + target folder in one call
- [ ] `search_files` — Drive search by name, mimeType, fullText, parent, modifiedTime

### Tier 2 — high-leverage rounding out

- [ ] `insert_table` + `update_table_cell` (Doc)
- [ ] `insert_image` (Doc)
- [ ] `apply_list_style` — promote paragraphs to bulleted/numbered/checklist lists
- [ ] `add_sheet` / `delete_sheet` / `rename_sheet` (Sheets tab management)
- [ ] `format_range` (Sheet) — bold/color/alignment/number-format/borders
- [ ] `delete_rows` / `delete_columns` / `insert_rows` / `insert_columns` (Sheet)
- [ ] `share_file` + `list_permissions` + `revoke_permission` + `create_share_link`
- [ ] `batch_update` — bundle multiple Doc or Sheet ops into one atomic call

### Tier 3 — nice-to-have

- [ ] `add_comment` / `list_comments` / `resolve_comment` (Doc)
- [ ] `accept_suggestions` / `reject_suggestions` (Doc tracked changes)
- [ ] `export_to_pdf` / `export_to_docx` / `export_to_xlsx`
- [ ] `get_thumbnail`
- [ ] `batch_move` / `batch_delete`
- [ ] `create_chart` (Sheet)
- [ ] `add_data_validation` (Sheet)

### Quality / infrastructure

- [ ] Error message wrapping with actionable suggestions (replace raw API passthrough)
- [ ] Auto-retry on transient 5xx + 429 rate-limit responses with exponential backoff
- [ ] Optional structured logging via `LOG_LEVEL` env var
- [ ] Test coverage for new handlers (vitest, mocked googleapis)
- [ ] README + docs update to cover the new tool inventory
- [ ] Schema-level validation of file IDs before API calls

## v0.3.0 (planned)

- Google Forms API integration — list forms, list responses, create form, add question (different OAuth scopes: `forms.body`, `forms.responses.readonly`)
- Google Slides API integration — create slides, replace placeholders, insert images
- Drive ID-format validators and friendlier validation errors
- Bulk import/export workflows (CSV → Sheet, Doc → Markdown, etc.)

## Out of scope (won't be done in this MCP)

- Multi-tenancy / hosted service — by design, this is a single-user MCP
- OAuth token sharing — each user creates their own Google Cloud OAuth client
- Real-time collaboration / Operational Transform — Drive's collaborative editing is a Google-side concern
- Drive Pictures (the deprecated photos library) — use Google Photos directly
- Workspace Admin APIs (group management, license assignment, etc.) — different scope, different risk profile, different audience
