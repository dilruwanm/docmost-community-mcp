# Task list: edit_page, token-cost savings, release 1.1.0

Plan: [plan.md](plan.md). Spec: [SPEC.md](../SPEC.md). Gate for every task: `npm run build && npm test` pass before its commit.

## Phase 0: Unknowns first

- [x] **T1: Spike on a throwaway Docmost (found v0.96.0)** (done, see [spike.md](spike.md); history shapes not observable) (S, scratch scripts outside the repo, findings in `tasks/spike.md`)
  - Needs: `DOCMOST_*` environment variables set by you, and the throwaway space name (plan decision 3).
  - Acceptance:
    - [ ] A `/pages/update` with `format: "json"`, `operation: "replace"` is accepted, and a page with a table, callout and an inline comment anchor keeps all three after a JSON read-modify-write of one paragraph.
    - [ ] Whether `slugId` works on both `/pages/info` and `/pages/update` with `format: "json"` is recorded.
    - [ ] Real, sanitized payloads saved for: `list_pages`, `list_child_pages`, `search_pages`, `get_page`, `get_page_history`, `get_history_version`, `get_breadcrumbs`, `get_backlinks`, `list_workspace_members`, `list_space_members`, `search_suggest`, `duplicate_page`, `move_page`, `get_current_user`.
    - [ ] A decision line: JSON write works (proceed) or fails (stop and ask you).
  - Verify: re-run the round trip once; compare page JSON before and after with a deep-equal on untouched nodes.
  - Dependencies: none. Files: `tasks/spike.md`, `scripts/fixtures/*.json`.

- [x] **T2: Measurement script and committed baseline** (S) (done; baseline is 24,523 chars because the script serializes the whole tools array, my first ad-hoc count of 24,481 summed per-tool JSON)
  - Acceptance:
    - [ ] `npm run measure` prints `tools/list` characters and estimated tokens, and pretty vs compact vs slim size of the `list_pages` fixture.
    - [ ] `scripts/baseline.json` stores the pre-change numbers (24,523 characters, 41 tools) and the pre-change `list_pages` output size from the real fixture.
  - Verify: `npm run measure` reproduces 24,523 on the unmodified code.
  - Dependencies: T1 (fixture). Files: `scripts/measure.ts`, `scripts/baseline.json`, `package.json`.

### Checkpoint A: review with you
- [ ] JSON write confirmed, fixtures captured, baseline recorded.

## Phase 1: Edit and partial-read

- [x] **T3: Outline and section finding** (S)
  - Acceptance:
    - [ ] `outline(doc)` returns `{level, text, offset}` per heading, in order.
    - [ ] `findSection(doc, "## Text" | "Text")` returns the node range from the heading to the next heading of the same or higher level; duplicate headings, a missing heading, and a pinned level that does not match each throw an error naming the candidates.
    - [ ] `sectionToMarkdown` renders a range through the existing `proseMirrorToMarkdown`.
  - Verify: `npm test` (new cases for nested levels, last section, duplicates).
  - Dependencies: none. Files: `src/util.ts`, `src/util.test.ts`.

- [x] **T4: Exact-text replace on ProseMirror JSON** (S)
  - Acceptance:
    - [ ] `replaceTextInDoc(doc, old, new, all)` edits within one block; zero matches throws; more than one throws unless `all`; a match spanning formatted runs keeps the first run's marks; sibling nodes and other blocks stay deep-equal.
  - Verify: `npm test` with a deep-equal check on untouched nodes.
  - Dependencies: T1. Files: `src/util.ts`, `src/util.test.ts`.

- [x] **T5: Section operations** (M)
  - Acceptance:
    - [ ] `replaceSection`, `insertAfterSection`, `deleteSection` change only the named range; other nodes stay deep-equal.
    - [ ] Untouched blocks keep their `attrs.id`; new blocks get a fresh 12-letter id (spike finding).
    - [ ] New Markdown is converted with the local converter; unsupported constructs (tables, blockquotes, images, nested lists, task lists) throw an error that names the construct (plan decision 1).
  - Verify: `npm test`.
  - Dependencies: T3. Files: `src/util.ts`, `src/util.test.ts`.

- [x] **T6: `edit_page` tool** (M)
  - Acceptance:
    - [ ] Modes `replace_text`, `replace_section`, `insert_after_section`, `delete_section`; `edits[]` applied in order in memory and written once; any failing edit writes nothing and the error names its index.
    - [ ] `expected_updated_at` mismatch refuses the write.
    - [ ] Honors `DOCMOST_READ_ONLY` and `assertWritable()`; accepts slugId; result is a minimal ack plus what changed.
  - Verify: stubbed-client tests assert the exact `/pages/update` payload, the stale refusal, the all-or-nothing rule and the read-only refusal; `npm run build`.
  - Dependencies: T4, T5. Files: `src/tools.ts`, `src/client.ts`, `src/client.test.ts`.

- [x] **T7: `get_page` partial reads** (M)
  - Acceptance:
    - [ ] `outline: true` returns headings only; `heading` returns that section as Markdown with the same match errors as T3; `max_chars` + `offset` page the Markdown body.
    - [ ] With none of the new params, `get_page` returns what 1.0.1 returned.
  - Verify: stubbed-client tests for each param and for the unchanged default; `npm test`.
  - Dependencies: T3. Files: `src/tools.ts`, `src/client.test.ts`.

### Checkpoint B: review with you
- [ ] `npm run build && npm test` green; edit and read flows reviewed; nothing outstanding in T1 findings.

## Phase 2: Output shaping

- [x] **T8: Compact JSON, no nulls** (XS)
  - Acceptance: `textResult` emits compact JSON and omits `null` and `undefined`; strings are untouched.
  - Verify: unit test; `npm run measure` shows at least 25% smaller on the `list_pages` fixture.
  - Dependencies: T2. Files: `src/util.ts`, `src/util.test.ts`.

- [x] **T9: Slim list and write-ack shapes with `verbose`** (M)
  - Acceptance:
    - [ ] `list_pages`, `list_child_pages`, `list_trash`, `search_pages` show `space` once per list and keep `id, slugId, title, icon, parentPageId, hasChildren, updatedAt` per item.
    - [ ] Write tools (`create_page`, `update_page`, `restore_page`, and the `edit_page` ack) return `id, slugId, title, updatedAt`.
    - [ ] `verbose: true` on each returns every field 1.0.1 returned (fixture-based test).
  - Verify: `npm test`; `npm run measure`.
  - Dependencies: T8. Files: `src/util.ts`, `src/tools.ts`, `src/util.test.ts`.

- [x] **T10: Slim pass-through tools** (M)
  - Acceptance: using the T1 payloads, drop only fields with no use to an agent for `get_page_history`, `get_breadcrumbs`, `get_backlinks`, `list_workspace_members`, `list_space_members`, `search_suggest`, `duplicate_page`, `copy_page_to_space`, `move_page`, `get_current_user`; each takes `verbose: true`; the CHANGELOG draft lists every dropped field.
  - Verify: fixture tests per tool for default and verbose; `npm run measure`.
  - Dependencies: T1, T9. Files: `src/util.ts`, `src/tools.ts`, `src/util.test.ts`. Split in two if it grows past five files.

- [x] **T11: Size guard** (S)
  - Acceptance: the `content` of `get_page` and `get_history_version` over the cap (named constant, about 40,000 characters) returns the first chunk with `truncated: true` and `next_offset`; following offsets reassembles the original exactly; `get_history_version` gains `max_chars`/`offset`.
  - Verify: unit test of reassembly; `npm test`.
  - Dependencies: T7. Files: `src/util.ts`, `src/tools.ts`, `src/util.test.ts`.

### Checkpoint C: review with you
- [ ] Measured savings vs baseline reported; `verbose` equivalence tests pass.

## Phase 3: Tool-list diet

- [x] **T12: Trim tool wording** (M)
  - Acceptance: shared schema constants replace repeated `describe` text; usage hints (for example the `list_pages` view explanation, `update_page` operation default) are kept; no tool is removed or renamed.
  - Verify: `npm run measure` shows a smaller `tools/list`; diff reviewed for lost hints.
  - Dependencies: T6, T7, T11 (tools exist). Files: `src/tools.ts`.

- [x] **T13: `DOCMOST_TOOLSETS`** (S)
  - Acceptance: unset registers all original 41 tools plus `edit_page`; a comma list (`pages,comments`) registers only those groups; an unknown name is a startup error listing valid names; documented in `.env.example`.
  - Verify: test with a stub server counting registered names for unset, a valid list and an invalid name.
  - Dependencies: T12. Files: `src/config.ts`, `src/tools.ts`, `.env.example`, a test file added to the `npm test` script in `package.json`.

- [x] **T14: Final measurement** (XS)
  - Acceptance: `npm run measure` shows `tools/list` below 24,523 characters with `edit_page` included; before and after numbers recorded for the CHANGELOG.
  - Dependencies: T13. Files: `tasks/measured.md`.

### Checkpoint D: review with you
- [ ] Final numbers reviewed.

## Phase 4: Release prep

- [x] **T15: Live smoke test** (S)
  - Acceptance: on the throwaway space, each `edit_page` mode, `edits[]` failure, stale `expected_updated_at`, `get_page` outline/heading/offset, truncation, `verbose`, and `DOCMOST_TOOLSETS` behave as specified; the comment anchor, table and callout in untouched sections survive in the UI.
  - Dependencies: T14, plan decision 3. Files: `tasks/smoke.md`.

- [x] **T16: Version bump to 1.1.0** (S)
  - Acceptance: `package.json`, `package-lock.json`, `USER_AGENT` in `src/client.ts`, and `PACKAGE_VERSION` in `src/index.ts` all read 1.1.0.
  - Verify: `grep -rn "1\.0\.1" src package.json package-lock.json` finds nothing relevant.
  - Dependencies: T15. Files: those four.

- [x] **T17: Docs and changelog** (S)
  - Acceptance: README lists `edit_page`, the `get_page` params, `verbose`, `DOCMOST_TOOLSETS` and the output-shape change; CHANGELOG `[1.1.0]` has Added / Changed (dropped fields, measured savings) and the `v1.0.1...v1.1.0` compare link.
  - Dependencies: T16. Files: `README.md`, `CHANGELOG.md`.

- [x] **T18: Release candidate** (XS)
  - Acceptance: `npm run build`, `npm test` and `npm pack --dry-run` are clean (only `dist`, README, CHANGELOG, LICENSE); branch committed; I hand you the exact merge, tag and publish commands. I do not push, tag or publish (plan decision 2); I give you the merge, `git tag v1.1.0` and `npm publish` commands.
  - Dependencies: T17.

### Checkpoint E: you merge, tag and publish
- [ ] All spec success criteria 1-13 met; ready for review.
