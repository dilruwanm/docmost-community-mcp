# T15 live smoke test, 2026-11-21

Server: a self-hosted Docmost v0.96.0 instance. Space: `mcp-sandbox` only (each page's space was verified before any edit). Driven through the built `dist/index.js` over stdio with a real MCP client, so config, tool registration and the live API were all in the path. The script was temporary and is not kept in the repo.

Result: **37/37 automated checks passed, plus the UI comment check** (first run 34/36; both failures were my test ordering, see "Known behavior").

## Rerun after the dependency update
After `npm audit fix` moved the MCP SDK from 1.30.0 to 1.32.2, the whole suite was rerun: build, 47 unit tests, sizes (tool list still 24,514 characters, 42 tools) and a fresh live smoke run of **38/38** checks, including `insert_in_section` and the UI-made comment surviving a further edit. Only `package-lock.json` changed.

## Passed (live)
- **Read side:** `get_page` `outline` lists the headings and every offset lands on its heading in the Markdown body; `heading` returns a section including its subsection; an unknown heading errors and lists the page's headings.
- **`edit_page`:**
  - `replace_text` works via slugId, changes exactly one block, and keeps the bold mark.
  - `replace_section` keeps the heading and swaps the body. The intro block and the Section B and C blocks, including the table and callout, are byte-identical afterwards, with their block ids intact. New paragraphs carry a block id.
  - `insert_after_section` lands after the subsection and before the next section. `delete_section` removes a subsection and keeps its parent.
  - A multi-edit batch applies all its edits in one write.
- **Refusals write nothing (checked by re-reading the page):** a batch with a failing second edit names `Edit #2`; an ambiguous `replace_text` is refused; unsupported Markdown (a table) is refused naming the construct; a stale `expected_updated_at` is refused and a matching one is accepted; `DOCMOST_READ_ONLY=true` refuses `edit_page`.
- **Size guard:** a 1,500-paragraph page (about 90k characters) returns 40,000 characters with `truncated` and `next_offset`; following `next_offset` reassembles it exactly, equal to one full read.
- **Slim output:** `list_pages` slim is under 60% of verbose with one shared `space`; `update_page` ack has 4 fields, and `verbose` returns full metadata; `get_current_user`, `list_workspace_members`, `get_breadcrumbs`, `search_pages` (scoped) work.
- **Config:** `DOCMOST_TOOLSETS=pages` exposes exactly 19 tools including `edit_page`; `pages,bogus` stops startup with the valid names.

## Known behavior (documented, not a bug)
Sections are flat. Text inserted with `insert_after_section` after a section's **last subsection** sits inside that subsection's range, so a later `delete_section` or `replace_section` on the subsection also removes it. **Resolved afterwards:** `insert_in_section` (`at: start|end`) adds blocks at the start of a section or at the end of its own body, before any subsection; a live check confirmed the text survives deleting the subsection that follows. README should still say that `insert_after_section` goes after all subsections.

## Not covered by this run
- Real history, backlinks, labels and comments payloads (empty in the sandbox).
- Any space other than `mcp-sandbox`, and Docmost versions other than v0.96.0.

## Passed: UI comment survival (comment made in the Docmost editor)
Page `T15 comment anchor` in `mcp-sandbox`. A person added an inline comment on "Anchor sentence " in the UI. Then `edit_page` `replace_text` changed "Change me." under "Edit target".
- The comment mark (`resolved: false`, its `commentId` unchanged) was still on the same words afterwards.
- Exactly one block changed (index 3 of 4); the edit applied.
- The comment row itself was unchanged (`get_comments` returned the same id before and after).
This closes the gap noted for T1, where the comment mark was one my own script had added.

## Sandbox leftovers
`T1 spike`, `T1 parent`, `T1 child` and a duplicate, `T15 smoke` (x2), `T15 big` (x2), `T15 comment anchor`. Deleting the `mcp-sandbox` space removes all of them.
