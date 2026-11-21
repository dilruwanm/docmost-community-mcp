# T1 spike findings

Run 2026-11-21 against a self-hosted Docmost instance, Docmost **v0.96.0** (the README's "latest verified" is v0.95.0; update it in T17). All writes went to the `mcp-sandbox` space, guarded in code. Scripts are in the session scratchpad, not the repo.

## Decision: JSON write works. Proceed with strategy A.

| Check | Result |
|---|---|
| `POST /pages/update` with `format: "json"`, `operation: "replace"`, `content` as a JSON **object** | Accepted. |
| Same call using the page **slugId** as `pageId` | Accepted. `/pages/info` with `format: "json"` also takes a slugId, so `edit_page` needs no extra lookup. |
| Comment mark `{type:"comment", attrs:{commentId, resolved}}` on a text run | Survives the write, with its attrs intact. |
| Table and callout nodes | Survive. Untouched nodes are byte-identical after a second write (JSON.stringify compare). |
| Editing one paragraph and writing the whole doc back | Result equals what was sent; `updatedAt` advances. |
| Markdown read of the same page | **Lossy for tables.** The header row came back as an empty row and `Col1/Col2` moved into the body. This confirms the Markdown strategy would alter untouched sections. |

Caveats:
- The first JSON write **normalizes** the doc: attrs that were `null` (`textAlign`, `align`, `colwidth`, `backgroundColor`, and the root `attrs.dir`) are dropped. Later round trips are stable. Harmless, but the "untouched nodes identical" test must compare against a doc that has already been read once.
- The comment mark was added by my script, not by the editor UI. Survival of a mark with that shape is proven; a mark made by the real editor is checked in the T15 smoke test.
- Every block carries `attrs.id` (random 12 letters). `edit_page` must keep these ids on untouched nodes and give new nodes fresh ones, or comment and link anchors elsewhere could break. Added to T5 acceptance.
- The login in `.env` is the workspace **owner**, not a restricted user. Every script refused to write outside `mcp-sandbox`.

## Real payload findings (drives T9 and T10)

Sizes are compact JSON bytes from the sandbox. Workspace-level payloads were measured for shape only and no values were saved.

| Tool | Finding | T10 action |
|---|---|---|
| `list_workspace_members` | 16 members = 8,297 bytes. Each has `email, name, role` plus `settings, locale, timezone, emailVerifiedAt, lastLoginAt, workspaceId, hasGeneratedPassword...` | Slim to `id, name, email, role`. Biggest single win. |
| `list_space_members` | `id, name, email, avatarUrl, type, role, createdAt` | Drop `avatarUrl`, `createdAt`. Small. |
| `search_suggest` | `{users, groups, pages}`; 734 of 767 bytes were one page object | Slim `pages` items like the list tools. |
| `duplicate_page` | Full page incl. `space`, `contributorIds`, `childPageIds` (688 bytes) | Return the page summary. |
| `get_breadcrumbs` | Per item `position, isBase, deletedAt, spaceId` repeated | Keep `id, slugId, title, icon`. |
| `move_page` | `{success, status}` only | Nothing to slim. |
| `update_page` response | Includes full `content`, `creator`, `lastUpdatedBy`, `contributors`, `permissions`, `space` (1,085 bytes for a one-line page, and it grows with the body) | `pageSummary` already drops `content`; the T9 minimal ack still helps. |
| `list_pages` / `list_child_pages` | The `space` object (87 bytes) is repeated per item in `recent` and `search` | T9: once per list. |
| `get_page_history`, `get_history_version`, `get_backlinks`, `list_page_labels`, `get_comments` | Empty in the sandbox. History stayed empty after several API writes, so the item shape was **not observed**. | Do **not** slim what has not been seen: only compact JSON applies (T8). `get_history_version` fixture is not available; T11's size guard is tested on a synthetic body instead. |

Fixtures (emails replaced, names replaced) are in `scripts/fixtures/`. `scripts/fixtures` must stay free of real people's data; only sandbox pages and the fixed placeholder user appear there.

## Effects on the plan

- T5 acceptance gains: untouched blocks keep their `attrs.id`; new blocks get a fresh 12-letter id.
- T10 is narrowed by the table above; History tools are left alone.
- T17: README "latest verified" becomes v0.96.0.
- T15: includes a comment created in the UI, then an edit elsewhere on that page.
- Sandbox pages left behind: `T1 spike`, `T1 parent`, `T1 child` and a duplicate. They go when you delete the space.
