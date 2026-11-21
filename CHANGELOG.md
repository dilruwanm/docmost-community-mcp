# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-21

### Added

- `edit_page`: change part of a page without rewriting the rest. It reads the page as ProseMirror JSON, applies its `edits` in order in memory and writes once, so tables, callouts, inline comments and untouched blocks come back exactly as they were. If any edit fails, nothing is written. Modes: `replace_text`, `replace_section` (keeps the heading, replaces what is under it, subsections included), `insert_in_section` (`at: "start"` or `"end"`, default: the end of the section's own body, before any subsection), `insert_after_section` (after the section and all its subsections) and `delete_section`. An optional `expected_updated_at` refuses the write if the page changed. New Markdown that cannot be represented (tables, blockquotes, callouts, images, nested or task lists, horizontal rules) is refused with an error naming the construct. Requires Docmost to accept `format: "json"` on `/api/pages/update` (verified on v0.96.0).
- `get_page` can read less: `outline` lists headings with offsets, `heading` returns one section as Markdown, and `max_chars` with `offset` page through the body.
- Size guard: `get_page` and `get_history_version` return at most 40,000 characters of text per call. When more remains the result has `truncated: true`, `total_chars` and `next_offset`; pass `next_offset` back as `offset`. `get_history_version` gains `max_chars` and `offset`. Not capped: `get_page` with `format=json`, and history content that is a JSON object.
- `DOCMOST_TOOLSETS`: optional comma list of tool groups to expose (`pages`, `spaces`, `comments`, `search`, `workspace`, `attachments`, `labels`, `members`). Unset means every tool. An unknown name stops startup with the valid names.
- `verbose: true` on the tools listed under Changed, which returns the 1.0.1 output.

### Changed

Results are smaller by default to save AI context. Anything that parses a field listed here must pass `verbose: true`.

- **All tools:** results are compact JSON, and fields whose value is `null` are omitted (absent means null).
- **`list_pages`, `list_child_pages`, `list_trash`:** items keep `id, slugId, title, icon, parentPageId, hasChildren, updatedAt`. Dropped: `spaceId, position, createdAt, creatorId, lastUpdatedById, permissions` and the per-item `space`. The shared `space` is shown once at the top of the list.
- **`search_pages`:** the per-item `spaceId` is dropped, and the per-item `space` is kept only when no `space_id` was given.
- **`create_page`, `update_page`, `restore_page`:** return `id, slugId, title, updatedAt`.
- **`duplicate_page`, `copy_page_to_space`:** return `id, slugId, title, updatedAt, parentPageId, childPageIds`.
- **`get_breadcrumbs`:** items keep `id, slugId, title, icon`. Dropped: `position, isBase, spaceId, deletedAt, hasChildren`.
- **`search_suggest`:** page suggestions drop `spaceId`.
- **`list_workspace_members`:** items keep `id, name, email, role`. Dropped: `emailVerifiedAt, avatarUrl, workspaceId, locale, timezone, settings, lastLoginAt, deactivatedAt, createdAt, updatedAt, deletedAt, hasGeneratedPassword`.
- **`list_space_members`:** items drop `avatarUrl` and `createdAt`.
- **`get_current_user`:** `user` keeps `id, name, email, role, workspaceId`; `workspace` keeps `id, name, defaultSpaceId, memberCount`. The version and read-only fields are unchanged.
- **Unchanged:** `get_page` metadata and body, `get_page_history`, `get_history_version`, `get_backlinks`, `list_page_labels`, `get_comments` and `move_page`. Their real payloads were empty or already small on the test server.
- Tool annotations now send only what differs from the MCP defaults (`readOnlyHint: true` for reads, `destructiveHint` for writes). `openWorldHint` and the redundant `readOnlyHint: false` / `destructiveHint: false` are no longer sent. Clients that follow the MCP spec's defaults see no difference.
- Tool and parameter descriptions are shorter; usage hints are kept.

Measured with `npm run measure` on the same code paths (sizes in characters; tokens are a rough estimate of characters / 3.5):

| | 1.0.1 | 1.1.0 |
|---|---|---|
| `list_pages`, 50 items | 31,290 (about 8.9k tokens) | 7,341 (about 2.1k tokens), 76.5% smaller |
| Tool list, all tools | 24,523 (41 tools) | 24,514 (42 tools, including `edit_page`) |
| Tool list, `DOCMOST_TOOLSETS=pages` | n/a | about 12,800 (19 tools) |

The tool list is essentially unchanged in size: the MCP SDK adds about 2.1 KB of `$schema` text to every tool, which this server cannot remove. The savings are in results, and in `DOCMOST_TOOLSETS` for people who do not need every tool.

## [1.0.1] - 2026-10-09

### Fixed

- Page tools now accept a page slugId anywhere a page id is required, as the tool schemas advertise. Previously the value was passed to Docmost unchanged, and endpoints that only accept UUIDs failed with misleading errors: `list_child_pages`, `delete_page`, `restore_page` and `move_page` returned 500 Internal server error, and `export_page` returned 400 "No accessible pages to export". SlugIds are now resolved to UUIDs before the request, including for `parent_page_id` and `after_page_id`. ([#1](https://github.com/dilruwanm/docmost-community-mcp/issues/1))

## [1.0.0] - 2026-08-26

### Added

- Initial public release: MCP server for self-hosted Docmost Community Edition with page, space, comment, search, attachment, label and space-member tools.

[1.1.0]: https://github.com/dilruwanm/docmost-community-mcp/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/dilruwanm/docmost-community-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/dilruwanm/docmost-community-mcp/releases/tag/v1.0.0
