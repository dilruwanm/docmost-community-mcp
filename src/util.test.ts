import assert from "node:assert/strict";
import test from "node:test";
import {
  asItems,
  compareSemver,
  exportFileName,
  generatePosition,
  markdownToProseMirror,
  parseVersion,
  proseMirrorToMarkdown,
  unwrap,
} from "./util.js";

test("unwrap prefers Docmost { data, success } envelopes", () => {
  assert.deepEqual(unwrap({ data: { id: "1" }, success: true, status: 200 }), { id: "1" });
  assert.deepEqual(unwrap({ id: "1" }), { id: "1" });
});

test("asItems accepts both array and paginated shapes", () => {
  assert.equal(asItems([{ id: 1 }]).items.length, 1);
  assert.equal(asItems({ items: [{ id: 1 }], meta: { hasNextPage: false } }).items.length, 1);
  assert.equal(asItems({ data: { items: [{ id: 1 }] } }).items.length, 1);
});

test("compareSemver orders Docmost versions", () => {
  assert.ok(compareSemver("0.71.0", "0.70.0") > 0);
  assert.ok(compareSemver("0.25.3", "0.71.0") < 0);
  assert.equal(compareSemver("0.95.0", "0.95.0"), 0);
});

test("parseVersion reads Docmost currentVersion payloads", () => {
  assert.equal(parseVersion({ version: "0.95.0" }), "0.95.0");
  assert.equal(parseVersion({ data: { releaseVersion: "v0.71.1" }, success: true }), "0.71.1");
  assert.equal(parseVersion({ currentVersion: "0.95.0", latestVersion: "0.96.0" }), "0.95.0");
  assert.equal(parseVersion({ data: { currentVersion: "v0.88.0" }, success: true }), "0.88.0");
  assert.equal(parseVersion("v0.71.0"), "0.71.0");
});

test("comment markdown round-trips through a simple ProseMirror doc", () => {
  const json = markdownToProseMirror("Hello\n\nWorld");
  assert.equal(json.type, "doc");
  assert.equal(proseMirrorToMarkdown(json), "Hello\n\nWorld");
});

test("comment markdown keeps lists and fenced code", () => {
  const source = "Intro\n\n- one\n- two\n\n```js\nconst x = 1\n```";
  const json = markdownToProseMirror(source);
  const types = (json.content as Array<{ type: string }>).map((node) => node.type);
  assert.deepEqual(types, ["paragraph", "bulletList", "codeBlock"]);
  const back = proseMirrorToMarkdown(json);
  assert.match(back, /^- one$/m);
  assert.match(back, /^- two$/m);
  assert.match(back, /```js/);
  assert.match(back, /const x = 1/);
});

test("proseMirrorToMarkdown reads list and codeBlock nodes from Docmost", () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "alpha" }] }],
          },
        ],
      },
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [{ type: "text", text: "type X = 1" }],
      },
    ],
  };
  const md = proseMirrorToMarkdown(doc);
  assert.equal(md, "- alpha\n\n```ts\ntype X = 1\n```");
});

test("exportFileName uses content-disposition, then zip magic, then markdown", () => {
  assert.equal(
    exportFileName({
      contentDisposition: 'attachment; filename="Smoke parent.md"',
      contentType: "text/markdown",
      bytes: new Uint8Array([35, 32]),
      fallbackBase: "page",
    }),
    "Smoke parent.md",
  );
  assert.equal(
    exportFileName({
      contentDisposition: null,
      contentType: "application/zip",
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      fallbackBase: "space-1",
    }),
    "space-1.zip",
  );
  assert.equal(
    exportFileName({
      contentDisposition: null,
      contentType: "text/markdown; charset=utf-8",
      bytes: new Uint8Array([35, 32, 72]),
      fallbackBase: "page-1",
    }),
    "page-1.md",
  );
});

test("generatePosition returns a 5-12 character key", () => {
  const first = generatePosition(null, null);
  const after = generatePosition("a0000", null);
  assert.ok(first.length >= 5 && first.length <= 12);
  assert.ok(after.length >= 5 && after.length <= 12);
  assert.notEqual(first, after);
});
