# Spec: Partial page updates, AI token-cost savings, release 1.1.0

Status: DRAFT, decisions recorded, awaiting final approval. Nothing below is implemented.

## Decisions (confirmed)

1. **Fidelity:** JSON-based (strategy A). If the Task 1 spike shows `/pages/update` does not accept `format: "json"`, stop and come back to you before falling back to Markdown.
2. **Modes:** all four (`replace_text`, `replace_section`, `insert_after_section`, `delete_section`).
3. **Concurrency:** `expected_updated_at` is optional.
4. **Tool shape:** separate `edit_page`, `update_page` unchanged (my default; you did not object).
5. **Release:** 1.1.0. I prepare the bump, changelog, README and a local commit and tag; **you** push the tag and run `npm publish`.
6. **Output slimming:** compact JSON, no `null` fields, slim list and write-ack responses, with `verbose: true` restoring the old shape.
7. **Partial reads and multi-edit:** `get_page` gains `outline`, `heading`, `max_chars`/`offset`; `edit_page` takes `edits[]`.
8. **Tool-definition diet:** trim wording, keep usage hints, add optional `DOCMOST_TOOLSETS`; the default stays all tools.
9. **Size guard:** truncate very large responses with `truncated` and `next_offset`; high default cap.
10. **Bundling:** all of the above ship in 1.1.0.

## Objective

Let an agent change one part of a Docmost page without resending, or risking, the rest of it.

**Today.** `update_page` (`src/tools.ts:185`) sends the whole body to `POST /api/pages/update` with `operation` = `replace`, `append` or `prepend`. To edit one paragraph, an agent must `get_page`, rewrite the full Markdown, and replace the entire body. That causes three problems:

1. **Token cost.** The full page goes out and comes back for a one-line change.
2. **Silent damage.** Anything the Markdown round trip cannot express (callouts, tables, mentions, attachments, inline comment anchors) is rewritten or dropped across the whole page, not only in the part being edited.
3. **Lost concurrent edits.** A read-modify-write over the whole page overwrites anything a human typed between the read and the write.

**Users.** LLM agents calling this MCP server, and the people whose pages they edit.

**Done means:** an agent can target a section or an exact snippet, the rest of the page is left unchanged, and ambiguous or stale edits fail loudly instead of guessing.

## Assumptions (correct me now or I proceed with these)

1. "Update parts of pages" means **targeted edits inside a page body**: by heading section and by exact text. It does not mean title, icon or metadata, which already work.
2. The Docmost API has **no native partial-update endpoint**. The only body write is `/pages/update` with `replace | append | prepend`, so partial edits must be done **client-side: read, transform, write back**. I have not confirmed this against a live server.
3. `/pages/update` accepts `format: "json"` (ProseMirror) as well as `"markdown"`. The README and code only use markdown writes, so this needs a spike on v0.95.0 before design is final (see Task 1).
4. This is **additive**: `update_page` keeps its current behavior, and the release is a **minor bump, 1.0.1 to 1.1.0**.
5. Target servers stay Docmost v0.71+ (`MIN_WRITE_VERSION`), verified on v0.95.0.
6. No new runtime dependencies. The existing hand-rolled `markdownToProseMirror` / `proseMirrorToMarkdown` in `src/util.ts` are minimal (no tables, blockquotes, nested lists, images, callouts), so the design must not depend on them for page content.

## Proposed behavior

One new tool, `edit_page`. Existing tools are unchanged.

| Param | Meaning |
|---|---|
| `page_id` | UUID or slugId |
| `mode` | `replace_text`, `replace_section`, `insert_after_section`, `delete_section` |
| `old_text` / `new_text` | for `replace_text`: exact match, must occur exactly once unless `replace_all: true` |
| `heading` | for section modes: heading text, optionally `"## Text"` to pin the level |
| `markdown` | new content for section modes |
| `expected_updated_at` | optional; refuse the write if the page changed since this timestamp |

Rules:
- A section runs from its heading to the next heading of the same or higher level, or the end of the page.
- `replace_section` keeps the heading and replaces everything under it, subsections included; use `replace_text` to rename a heading. `insert_after_section` inserts after the section and its subsections. `insert_in_section` (`at: start|end`, default end) inserts at the start of the section or at the end of its own body before any subsection. `delete_section` removes the heading, body and subsections. New Markdown that the local converter cannot represent (tables, blockquotes, callouts, images, nested or task lists, horizontal rules) is refused with an error naming the construct.
- No match, or more than one match, is an error that names the candidates. The tool never edits the "closest" one.
- The result returns the page summary plus what changed (section or snippet, before/after length), not the full body.
- Honors `DOCMOST_READ_ONLY` and the existing `assertWritable()` version gate.

### Fidelity strategy (decision needed, see Open Questions)

| | A. JSON-based (recommended) | B. Markdown-based |
|---|---|---|
| How | `get_page` with `format=json`, edit only the target nodes, write back with `format=json`, `operation=replace` | `get_page` as Markdown, string-edit, write back as Markdown |
| Untouched sections | Preserved as-is, including comment anchors and unsupported nodes | Rewritten by the server converter; may be altered |
| Size | More code (walk the node array to find sections) | About 30 lines |
| Depends on | Assumption 3 holding on the server | Nothing new |

Both strategies still send the whole body in one request. They differ in whether the untouched part is rewritten from its original form or round-tripped through Markdown.

## Token-cost savings (no functionality removed)

**Baseline measured on 2026-11-21:** 41 tools, 24,523 characters of `tools/list` JSON (about 7k tokens, rough estimate), and `JSON.stringify(data, null, 2)` at `src/util.ts:455`. On a synthetic 50-item page list, compact JSON was 26% smaller and compact plus slimmed items 67% smaller. The synthetic figures are indicative only; Task 0 re-measures on real payloads.

### Capability map

This work bundles independently testable capabilities, so it is split into modules with a build order. One spec file covers all of them; each module has its own success criteria below.

| Module id | Responsibility | Depends on |
|---|---|---|
| `sections` | Pure helpers: find sections by heading in ProseMirror JSON, exact-text replace | none |
| `edit-page` | `edit_page` tool: four modes, `edits[]`, `expected_updated_at` | `sections` |
| `read-partial` | `get_page` `outline`, `heading`, `max_chars`/`offset` | `sections` |
| `slim-output` | Compact JSON, null-dropping, slim list and ack shapes, `verbose` opt-in | none |
| `size-guard` | Truncate oversized results with `truncated` and `next_offset` | `slim-output` (shared output path) |
| `tool-diet` | Trim tool wording, optional `DOCMOST_TOOLSETS` filter | none |

Build order: `sections`, then `edit-page` and `read-partial`; `slim-output`, then `size-guard`; `tool-diet` last, because it re-measures the final tool list including `edit_page`.

### Module requirements

- **`slim-output`.** `textResult` emits compact JSON and omits `null` and `undefined` fields. List tools (`list_pages`, `list_child_pages`, `list_trash`, `search_pages`) show the shared `space` once per list, not per item. Slim items keep `id, slugId, title, icon, parentPageId, hasChildren, updatedAt`. Write tools return a minimal ack (`id, slugId, title, updatedAt`). Every tool that is slimmed accepts `verbose: true` to return today's full shape. Pass-through tools (`get_page_history`, `get_breadcrumbs`, `get_backlinks`, `list_*_members`, `search_suggest`, `duplicate_page`, `copy_page_to_space`, `move_page`, `get_current_user`) are slimmed only after Task 0 shows their real payloads; any field dropped is recorded in the CHANGELOG.
- **`read-partial`.** `outline: true` returns headings only (level, text, character offset). `heading` returns that one section as Markdown, with the same match rules as `edit_page`. `max_chars` plus `offset` page through a body. Default `get_page` behavior is unchanged.
- **`edit-page` `edits[]`.** An ordered list of the four edit modes applied in memory, then written once. If any edit fails, nothing is written and the error names the failing index.
- **`size-guard`.** Past about 40,000 characters (named constant), return the first chunk with `truncated: true` and `next_offset`, and say how to continue (`get_page` `offset`, or a heading). Normal pages are unaffected.
- **`tool-diet`.** Remove repeated wording (for example the shared `pageId` description) and keep the usage hints. `DOCMOST_TOOLSETS` is a comma list (for example `pages,comments`); unset means all tools. The names of the sets are decided in Task 0 from the 41 existing tools.

## Tech stack

TypeScript 5.9 (strict), Node >=20, ESM, `@modelcontextprotocol/sdk` ^1.30, `zod` ^3.25. Tests use the built-in `node:test` through `tsx`. No new dependencies.

## Commands

```
Install:  npm ci
Build:    npm run build          # tsc, output in dist/
Test:     npm test               # tsx --test src/util.test.ts src/client.test.ts
Dev:      npm run dev            # tsx src/index.ts
Pack:     npm pack --dry-run     # check what would be published
```

`npm test` lists test files explicitly. A new test file must be added to that script in `package.json`.

## Project structure

```
src/tools.ts        MCP tool registration. Add edit_page next to update_page
src/client.ts       Docmost HTTP client. Add any read-then-write helper here
src/util.ts         Pure helpers. Section finding and text replace go here so they are unit-testable
src/*.test.ts       node:test unit tests, no network
README.md           Tool list (line ~30) and design notes (line ~109)
CHANGELOG.md        Keep a Changelog format
```

## Code style

Match the existing code: small pure functions in `util.ts`, tools wrapped in `wrap(client, "write", ...)`, zod schemas inline, errors thrown as `DocmostError` and surfaced through `errorResult`.

```ts
// util.ts: pure, throws on ambiguity, testable without a server
export function replaceText(body: string, oldText: string, newText: string, all = false): string {
  const count = body.split(oldText).length - 1;
  if (count === 0) throw new DocmostError("old_text not found");
  if (count > 1 && !all) throw new DocmostError(`old_text matches ${count} places; add context or set replace_all`);
  return body.split(oldText).join(newText);
}
```

## Testing strategy

- **Unit (`node:test`):** section boundary detection (nested levels, last section, duplicate headings, headings inside code fences), `replace_text` (0, 1, many matches), JSON node edits leave sibling nodes byte-identical. No network, same style as `util.test.ts`.
- **Client-level:** stub `client.request` like `client.test.ts` does, and assert `edit_page` sends the exact `/pages/update` payload and refuses when `expected_updated_at` is stale.
- **Manual smoke against a real Docmost v0.95.0 (required before release):** create a page with a heading, table, callout and an inline comment; run each `edit_page` mode; confirm the other sections and the comment anchor survive in the UI. Unit tests cannot prove this.
- Coverage is not gated. Every new branch (not found, ambiguous, stale, read-only) needs a test.

## Boundaries

- **Always:** run `npm run build && npm test` before committing; resolve slugIds through `client.resolvePageId`; fail on ambiguity instead of guessing; keep `update_page` backward compatible.
- **Ask first:** adding a dependency (for example a Markdown parser); changing `update_page` semantics; pushing a tag or running `npm publish`.
- **Never:** commit credentials or `.env`; run the smoke test against a production workspace (use a throwaway space); remove or skip a failing test; publish without the smoke test passing.

## Release plan (1.1.0)

Version strings that must change together (the 1.0.1 release shows three places, plus the lockfile):

- `package.json` `version`
- `package-lock.json` (via `npm version 1.1.0 --no-git-tag-version`)
- `src/client.ts:19` `USER_AGENT`
- `src/index.ts:9` `PACKAGE_VERSION`
- `CHANGELOG.md`: new `[1.1.0]` entry under **Added**, plus the compare link at the bottom (`v1.0.1...v1.1.0`)
- `README.md`: add `edit_page` to the Pages list and one design note

I stop after a local commit and `v1.1.0` tag. **You** then push the tag and run `npm publish` (access is public, `prepublishOnly` runs `tsc`). Tags `v1.0.0` and `v1.0.1` exist, so this follows the pattern.

## Success criteria

1. `edit_page` with `replace_text` changes exactly one snippet; a diff of the page JSON before and after shows no other change (strategy A) or no change beyond server-converter normalization (strategy B).
2. `replace_section` / `insert_after_section` / `delete_section` touch only the named section and its trailing boundary.
3. Zero matches, multiple matches, a missing heading and a stale `expected_updated_at` each return an `isError` result and write nothing.
4. An inline comment anchor in an untouched section survives (strategy A required; strategy B reported as a known limit).
5. `DOCMOST_READ_ONLY=true` refuses `edit_page`.
6. `npm run build` and `npm test` pass; `npm pack --dry-run` shows only `dist`, README, CHANGELOG and LICENSE.
7. Version reads 1.1.0 in all four places above; `npx docmost-community-mcp` from the published package starts and lists `edit_page`.
8. **Cost, measured with a script kept in the repo (not eyeballed):** compact JSON cuts a 50-item `list_pages` result by at least 25% against the pre-change output; slim lists cut it further; the final `tools/list` is smaller than the 24,523-character baseline despite adding `edit_page`. The measured before and after numbers go in the CHANGELOG.
9. `verbose: true` on every slimmed tool returns every field the 1.0.1 output had (checked by a test against a fixture).
10. `get_page` with no new params returns what 1.0.1 returned, apart from compact formatting and dropped nulls.
11. A body over the size cap returns `truncated: true`; following `next_offset` reassembles the original body exactly.
12. With `DOCMOST_TOOLSETS` unset, the 41 original tools are all present; with it set, only the named sets are listed and calls to others are not registered.
13. An `edits[]` call with one bad edit writes nothing.

## Open questions

None blocking. Known residual risks: the `format: "json"` write assumption is unverified (Task 0 spike); slimmed default shapes could break a consumer that parses fields we drop (mitigated by `verbose`, and called out in the CHANGELOG); and a small race window remains between the `expected_updated_at` check and the write because Docmost has no compare-and-set.

## Plan preview (not started)

0. Spike and measure against v0.95.0 on a throwaway space: confirm `format: "json"` writes round-trip and keep comment marks (stop and ask you if not); capture real payloads from the pass-through tools; write the token-measurement script.
1. `sections` helpers in `util.ts` plus unit tests.
2. `edit-page` (with `edits[]`) and `read-partial`, plus client-level tests.
3. `slim-output`, then `size-guard`.
4. `tool-diet`, re-measure `tools/list`.
5. Manual smoke test on a throwaway space.
6. Docs, version bump, changelog with measured numbers, local commit and tag. You push and publish.
