# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-10

Initial release. Thirteen tools across Drive, Docs, and Sheets.

### Added

- **Drive**: `move_file`, `rename_file`, `delete_file`, `restore_file`, `list_folder`
- **Docs**: `find_and_replace`, `append_to_doc`, `insert_at_heading`, `apply_text_style`
- **Sheets**: `append_row`, `update_cell`, `update_range`, `find_and_replace_in_sheet`
- One-time OAuth setup CLI (`npx @armoryworks/drive-mcp auth`) with local-listener consent flow.
- Token persistence at `~/.armoryworks/drive-mcp/tokens.json` with auto-refresh on expiry.
- Full README and OAuth-setup walkthrough.
