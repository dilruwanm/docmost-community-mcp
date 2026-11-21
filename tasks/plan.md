# Implementation Plan: edit_page, token-cost savings, release 1.1.0

Spec: [SPEC.md](../SPEC.md) (approved). Task details and checkboxes: [todo.md](todo.md). No external tracker is configured, so `tasks/todo.md` is the task list.

## Overview

Add targeted page edits (`edit_page`) and partial reads, cut AI token cost (compact and slim output, size guard, leaner tool list), and release 1.1.0. Work is on a feature branch, one commit per checkpoint. Nothing is pushed, tagged or published without you.

## Dependency graph

```
T1 spike (live v0.95.0) ──┬──────────────► T4 text replace ─┐
                          │                                 ├─► T6 edit_page ─┐
T2 measure script         │   T3 outline/section find ──────┤                 │
  │                       │         └─► T5 section ops ─────┘                 ├─► T15 smoke ─► T16 bump ─► T17 docs ─► T18 release prep
  │                       │         └─► T7 get_page partial reads ─► T11 size guard ┤
  │                       └─► T10 slim pass-through tools                           │
  └─► T8 compact JSON ─► T9 slim lists/acks ─► T10 ─────────────────────────────────┤
                                                 T12 trim wording ─► T13 toolsets ─► T14 final measure
```

Order: fail fast on the two unknowns (JSON write, real payloads), then pure helpers, then tools, then output shaping, then tool-list diet last (it measures the final tool list), then release.

## Architecture decisions

- Section and text logic is pure code in `src/util.ts` over ProseMirror JSON, tested without a server. Tools in `tools.ts` stay thin.
- `replace_text` matches within a single block (paragraph, heading, list item) on the block's joined text. A match spanning several formatted runs is replaced and takes the marks of the first run touched. Matches across blocks are not supported. `shortcut: single-block matching, upgrade if agents need cross-paragraph replace`.
- All writes are `POST /pages/update` with `format: "json"`, `operation: "replace"` (pending T1). Reads use `/pages/info` with `format: "json"`. slugIds work on both endpoints, so `edit_page` needs no extra lookup.
- `expected_updated_at` is compared against the `updatedAt` from the read inside the same call, then the write goes immediately. The race window is small but not zero.
- The size guard applies to the `content` string of `get_page` and `get_history_version` (the unbounded fields). List tools are already bounded by `limit`.
- `DOCMOST_TOOLSETS` names mirror the existing register functions: `pages, spaces, comments, search, workspace, attachments, labels, members`.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `/pages/update` does not accept `format: "json"` or drops comment marks | High | T1 is first. If it fails I stop and ask you before falling back to Markdown. |
| **New Markdown for section modes needs a Markdown to ProseMirror converter.** The local one (`markdownToProseMirror`) has no tables, blockquotes, images, nested lists or task lists. | High | T5 rejects unsupported constructs with a clear error instead of mangling them. See Open Questions. |
| Slimmed default output breaks a consumer that parses a dropped field | Med | `verbose: true`, fixture test that verbose equals the 1.0.1 shape, CHANGELOG lists dropped fields. |
| Dropping `null` fields makes "root page" (`parentPageId: null`) look like "unknown" | Low | Document it; `verbose` restores it. |
| Need a throwaway Docmost space and credentials for T1 and T15 | Blocker | Ask before T1. I will not run against a production workspace. |
| Trimmed descriptions make a model pick the wrong tool | Med | Keep the usage hints, trim only repeated wording; compare before and after tool-selection by reading the diff. |

## Decisions from plan review

1. **Markdown for section modes (T5):** use the local converter and reject unsupported constructs (tables, blockquotes, images, nested or task lists) with an error naming the construct. No `nodes` parameter. `replace_text` is unaffected.
2. **Tagging (T18):** I do not tag. After you merge, I give you the exact `git tag` and `npm publish` commands. This replaces the "local tag" part of spec decision 5.
3. **Test server (T1, T15):** a throwaway space on a v0.95.0 instance that you provide. Credentials go in environment variables you set (`DOCMOST_URL` plus `DOCMOST_EMAIL`/`DOCMOST_PASSWORD` or `DOCMOST_AUTH_TOKEN`), never pasted into chat or written to the repo. **Still needed from you before T1:** the instance, and the name of the throwaway space.

## Checkpoints

- **A (after T1-T2):** the JSON write works, real payloads captured, baseline recorded. Review with you.
- **B (after T3-T7):** edit and partial-read behavior fully unit-tested; `npm run build && npm test` green. Review with you.
- **C (after T8-T11):** output shaping done, savings measured against baseline.
- **D (after T12-T14):** final tool-list size below baseline.
- **E (after T15-T18):** smoke test passed, release candidate ready for you to merge and publish.
