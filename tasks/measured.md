# Measured savings (T14), 2026-11-21

Produced by `npm run measure` through the real MCP tool path against `scripts/baseline.json` (1.0.1). Tokens are characters / 3.5, a rough estimate only.

| What | 1.0.1 | 1.1.0 | Change |
|---|---|---|---|
| Tools exposed | 41 | 42 (adds `edit_page`) | +1 |
| `tools/list`, all tools | 24,523 chars (~7.0k tokens) | 24,514 chars (~7.0k tokens) | -0.04% |
| `tools/list` with `DOCMOST_TOOLSETS=pages` (19 tools) | n/a | 12,814 chars | -48% vs all |
| `tools/list` with `pages,comments,search` (25 tools) | n/a | 16,146 chars | -34% vs all |
| `list_pages`, 50 items | 31,290 chars (~8.9k tokens) | 7,341 chars (~2.1k tokens) | **-76.5%** |
| of which compact JSON and no nulls alone | 31,290 | 22,795 | -27.1% |

Reading this honestly:
- The all-tools list is only marginally smaller than 1.0.1 even though it now includes `edit_page`, the `get_page` paging parameters and `verbose` on 12 tools. About 2.1 KB of it is a `$schema` line the MCP SDK adds to every tool, which this server cannot remove.
- The real savings are in results (lists, acknowledgements, long pages) and in `DOCMOST_TOOLSETS` for people who do not need every tool.
- The `list_pages` figure uses the 3 real sandbox items repeated to 50, so it reflects real item shapes but not real titles or long icons.
- Not measured: `get_page` on a large real page (the cap and paging are tested on a synthetic 4,000-paragraph body), and live-server results (T15).
