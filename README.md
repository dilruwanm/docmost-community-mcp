# docmost-community-mcp

Model Context Protocol server for self-hosted [Docmost](https://docmost.com) **Community / Open Source Edition**.

Source: [github.com/dilruwanm/docmost-community-mcp](https://github.com/dilruwanm/docmost-community-mcp)

Official Docmost MCP and API keys are Enterprise-only. This server talks to the same internal HTTP API the Docmost web app uses, so you can search, read, write, and organize a CE wiki from Cursor, Claude, or any MCP client.

Requires **Docmost v0.71+** for Markdown body writes. Latest verified target is **v0.95.0**.

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

**Pages:** `search_pages`, `get_page`, `create_page`, `update_page`, `list_pages`, `list_child_pages`, `duplicate_page`, `copy_page_to_space`, `move_page`, `move_page_to_space`, `delete_page`, `restore_page`, `list_trash`, `get_page_history`, `get_history_version`, `get_breadcrumbs`, `get_backlinks`, `export_page`

**Spaces:** `list_spaces`, `get_space`, `create_space`, `update_space`, `delete_space`, `export_space`

**Comments:** `get_comments`, `create_comment`, `update_comment`, `delete_comment`

**Search / people:** `search_attachments`, `search_suggest`, `list_workspace_members`, `get_current_user`

**Files / labels / access:** `upload_attachment`, `get_attachment_info`, `list_page_labels`, `add_page_labels`, `remove_page_label`, `list_space_members`, `add_space_members`, `remove_space_member`, `update_space_member_role`

Page and comment bodies are **Markdown**. Updates go through `POST /api/pages/update` with `format: "markdown"` so Docmost converts and applies the change in place. The server does not open a Yjs socket or invent its own TipTap schema.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `DOCMOST_URL` | yes | Instance URL, e.g. `https://docs.example.com` |
| `DOCMOST_EMAIL` + `DOCMOST_PASSWORD` | one auth method | Community login |
| `DOCMOST_AUTH_TOKEN` | one auth method | `authToken` cookie from the browser |
| `DOCMOST_SESSION_PATH` | no | Session cache file |
| `DOCMOST_READ_ONLY` | no | `true` / `1` / `yes` — search and read only; mutating tools are refused |

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
- `search_attachments` is Enterprise-only; Community hosts get a clear 403 message.
- Export tools write a zip or a single `.md`/`.html` file to `output_path` or a temp file and return the path.

## License

MIT. This package does not include Docmost AGPL or Enterprise source.
