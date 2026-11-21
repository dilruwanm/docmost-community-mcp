# CHANGELOG draft for 1.1.0 (becomes CHANGELOG.md in T17)

### Changed: default output is smaller. Pass `verbose: true` to get the 1.0.1 shape back.

- **All tools:** results are compact JSON, and fields whose value is `null` are omitted (absent means null).
- **`list_pages`, `list_child_pages`, `list_trash`:** items keep `id, slugId, title, icon, parentPageId, hasChildren, updatedAt`. Dropped by default: `spaceId, position, createdAt, creatorId, lastUpdatedById, permissions` and the per-item `space`. The shared `space` is shown once at the top of the list.
- **`search_pages`:** per-item `spaceId` is dropped. Per-item `space` is kept only when no `space_id` was given.
- **`create_page`, `update_page`, `restore_page`:** return `id, slugId, title, updatedAt`.
- **`duplicate_page`, `copy_page_to_space`:** return `id, slugId, title, updatedAt, parentPageId, childPageIds`.
- **`get_breadcrumbs`:** items keep `id, slugId, title, icon`. Dropped: `position, isBase, spaceId, deletedAt, hasChildren`.
- **`search_suggest`:** page suggestions drop `spaceId`.
- **`list_workspace_members`:** items keep `id, name, email, role`. Dropped: `emailVerifiedAt, avatarUrl, workspaceId, locale, timezone, settings, lastLoginAt, deactivatedAt, createdAt, updatedAt, deletedAt, hasGeneratedPassword`.
- **`list_space_members`:** items drop `avatarUrl` and `createdAt`.
- **`get_current_user`:** `user` keeps `id, name, email, role, workspaceId`; `workspace` keeps `id, name, defaultSpaceId, memberCount`; version and read-only fields are unchanged.
- **Not changed:** `get_page` (metadata and body), `get_page_history`, `get_history_version`, `get_backlinks`, `list_page_labels`, `get_comments`, `move_page`. Their real payloads were empty or already small on the test server.

### Added

- `edit_page` (modes: `replace_text`, `replace_section`, `insert_after_section`, `insert_in_section`, `delete_section`), `get_page` `outline`/`heading`/`max_chars`/`offset` (see SPEC.md).
- `insert_in_section` with `at: "start"` (right under the heading) or `at: "end"` (default; end of the section's own body, before any subsection). Use it instead of `insert_after_section` when the new text belongs to the section itself, because text added after a section's last subsection becomes part of that subsection.

### Added: size guard

- `get_page` and `get_history_version` return at most 40,000 characters of text content per call. When more remains the result has `truncated: true`, `total_chars` and `next_offset`; pass `next_offset` back as `offset` to continue. `get_history_version` gains `max_chars` and `offset`.
- Limits: `get_page` with `format=json` and `get_history_version` content that is a JSON object are not capped (history shape was not observable on the test server).

### Added: `DOCMOST_TOOLSETS`

- Optional comma list to expose only some tools. Names: `pages, spaces, comments, search, workspace, attachments, labels, members`. Unset means every tool. An unknown name stops startup with the valid names. `get_current_user` is in `workspace`, `search_pages` in `pages`.
- Measured: all 42 tools 24,340 characters; `pages` only (19 tools) 12,640; `pages,comments,search` (25 tools) 15,972.
