# docmost-community-mcp

Model Context Protocol server for self-hosted [Docmost](https://docmost.com) **Community / Open Source Edition**.

Source: [github.com/dilruwanm/docmost-community-mcp](https://github.com/dilruwanm/docmost-community-mcp)

Official Docmost MCP and API keys are Enterprise-only. This server talks to the same internal HTTP API the Docmost web app uses, so you can search, read, write, and organize a CE wiki from Cursor, Claude, or any MCP client.

Requires **Docmost v0.71+** for Markdown body writes. Latest verified target is **v0.96.0**.

## Install

```bash
npx -y docmost-community-mcp
```

From source:

```bash
git clone https://github.com/dilruwanm/docmost-community-mcp.git
cd docmost-community-mcp
npm install
npm run build
```

## What you get

Official Enterprise MCP tool names, plus Community extras those docs omit.

**Pages:** `search_pages`, `get_page`, `create_page`, `update_page`, `edit_page`, `list_pages`, `list_child_pages`, `duplicate_page`, `copy_page_to_space`, `move_page`, `move_page_to_space`, `delete_page`, `restore_page`, `list_trash`, `get_page_history`, `get_history_version`, `get_breadcrumbs`, `get_backlinks`, `export_page`

**Spaces:** `list_spaces`, `get_space`, `create_space`, `update_space`, `delete_space`, `export_space`

**Comments:** `get_comments`, `create_comment`, `update_comment`, `delete_comment`

**Search / people:** `search_attachments`, `search_suggest`, `list_workspace_members`, `get_current_user`

**Files / labels / access:** `upload_attachment`, `get_attachment_info`, `list_page_labels`, `add_page_labels`, `remove_page_label`, `list_space_members`, `add_space_members`, `remove_space_member`, `update_space_member_role`

Page and comment bodies are **Markdown**. `update_page` goes through `POST /api/pages/update` with `format: "markdown"` so Docmost converts and applies the change in place. `edit_page` (below) edits the page's ProseMirror JSON instead, so untouched content is written back exactly as it was read. The server does not open a Yjs socket or invent its own TipTap schema.

## Editing part of a page

`update_page` replaces, appends or prepends a whole body. To change one part, use `edit_page`: it reads the page, applies your edits in memory and writes once. Tables, callouts, inline comments and every block you did not touch are sent back unchanged. If any edit fails, nothing is written.

```json
{
  "page_id": "aB3dE5fG7h",
  "expected_updated_at": "2026-11-21T12:00:00.000Z",
  "edits": [
    { "mode": "replace_text", "old_text": "v1.0", "new_text": "v1.1" },
    { "mode": "replace_section", "heading": "## Status", "markdown": "Shipped." },
    { "mode": "insert_in_section", "heading": "Install", "markdown": "Requires Node 20." }
  ]
}
```

| Mode | What it does |
|---|---|
| `replace_text` | Replaces `old_text` with `new_text`. It must match exactly once, inside one paragraph, heading or list item, unless `replace_all` is set. Formatting around the match is kept. |
| `replace_section` | Keeps the heading and replaces everything under it, **subsections included**. Rename a heading with `replace_text`. |
| `insert_in_section` | Adds blocks to a section. `at: "end"` (default) is the end of the section's own body, before any subsection; `at: "start"` is right under the heading. |
| `insert_after_section` | Adds blocks after the section **and all its subsections**. |
| `delete_section` | Removes the heading, its body and its subsections. |

How sections work:

- `heading` is the heading's text (case-insensitive), or `"## Text"` to pin the level. A missing heading, or a name that matches more than one section, is an error that lists the candidates.
- A section runs from its heading to the next heading of the same or higher level. Sections are flat: text sitting after a subsection's content belongs to that subsection. To add text to a parent section ahead of its subsections, use `insert_in_section`, not `insert_after_section`.
- Only top-level headings count; headings inside callouts or tables do not.
- New `markdown` supports headings, paragraphs, one-level bullet and numbered lists, fenced code, and bold, italic, code and links. Tables, blockquotes, callouts, images, nested or task lists and horizontal rules are refused with an error naming the construct. Use `replace_text` to change text inside existing rich content.
- `expected_updated_at` (optional) refuses the write if the page changed since that `updatedAt`. There is still a small window between the check and the write.

## Reading less

`get_page` can return part of a page: `outline: true` lists the headings with offsets, `heading` returns one section as Markdown, and `max_chars` plus `offset` page through the body. Text longer than 40,000 characters is cut off with `truncated: true` and a `next_offset`; pass it back as `offset` to continue. `get_history_version` pages the same way. `format=json` bodies are not capped.

## Smaller responses

To save AI context, list and write results are slim by default (for example `list_pages` items keep `id, slugId, title, icon, parentPageId, hasChildren, updatedAt`, with the shared `space` shown once), fields that are `null` are omitted, and JSON is compact. Pass `verbose: true` to get the full metadata. The [CHANGELOG](CHANGELOG.md) lists exactly which fields each tool drops.

`DOCMOST_TOOLSETS` limits which tools are exposed, which shrinks the tool list your client sends to the model on every request.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `DOCMOST_URL` | yes | Instance URL, e.g. `https://docs.example.com` |
| `DOCMOST_EMAIL` + `DOCMOST_PASSWORD` | one auth method | Community login |
| `DOCMOST_AUTH_TOKEN` | one auth method | `authToken` cookie from the browser |
| `DOCMOST_SESSION_PATH` | no | Session cache file |
| `DOCMOST_READ_ONLY` | no | `true` / `1` / `yes` — search and read only; mutating tools are refused |
| `DOCMOST_TOOLSETS` | no | Comma list of tool groups to expose: `pages`, `spaces`, `comments`, `search`, `workspace`, `attachments`, `labels`, `members`. Unset means all tools. An unknown name stops startup. |

Email/password is preferred. The JWT is cached under `~/.docmost-community-mcp/session.json` and refreshed on 401. MFA accounts cannot complete login here — use `DOCMOST_AUTH_TOKEN` instead.

Use a dedicated Docmost user. Do not commit credentials.

## Cursor

Add to `.cursor/mcp.json` or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "docmost": {
      "command": "npx",
      "args": ["-y", "docmost-community-mcp"],
      "env": {
        "DOCMOST_URL": "https://docs.example.com",
        "DOCMOST_EMAIL": "you@example.com",
        "DOCMOST_PASSWORD": "your-password"
      }
    }
  }
}
```

From a local clone:

```json
{
  "mcpServers": {
    "docmost": {
      "command": "node",
      "args": ["/absolute/path/to/docmost-community-mcp/dist/index.js"],
      "env": {
        "DOCMOST_URL": "https://docs.example.com",
        "DOCMOST_EMAIL": "you@example.com",
        "DOCMOST_PASSWORD": "your-password"
      }
    }
  }
}
```

## Claude Desktop / Claude Code

Same `mcpServers` block as above. Claude Code:

```bash
claude mcp add docmost --env DOCMOST_URL=https://docs.example.com --env DOCMOST_EMAIL=you@example.com --env DOCMOST_PASSWORD=secret -- npx -y docmost-community-mcp
```

## Design notes

- **stdio only** in this release. Streamable HTTP can be added later.
- **No Enterprise license, no Docmost database access, no Docmost fork.**
- Space slugs are accepted anywhere a space id is required.
- Page slugIds (the id in page URLs) are accepted anywhere a page id is required, and are resolved to UUIDs before the request.
- `move_page` computes the required fractional `position` key (`first`, `last`, or after a sibling).
- `create_page` / `update_page` fail clearly on servers older than v0.71 instead of silently dropping the body. `get_current_user` reports `docmostVersion` from Docmost's `currentVersion` field.
- `delete_space` requires `confirm: true`. Mutating tools honor `DOCMOST_READ_ONLY`.
- `list_pages` defaults to recently updated pages. Pass `view=tree` for sidebar-root pages.
- `edit_page` needs Docmost to accept `format: "json"` on `/api/pages/update`; this was verified on v0.96.0. It writes the whole page body back in one request, so a person typing in the editor at the same moment can still be overwritten (see `expected_updated_at`).
- `search_attachments` is Enterprise-only; Community hosts get a clear 403 message.
- Export tools write a zip or a single `.md`/`.html` file to `output_path` or a temp file and return the path.

## License

MIT. This package does not include Docmost AGPL or Enterprise source.
