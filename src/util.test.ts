import assert from "node:assert/strict";
import test from "node:test";
import {
  asItems,
  compareSemver,
  applyEdits,
  deleteSection,
  exportFileName,
  findSection,
  insertAfterSection,
  insertInSection,
  generatePosition,
  markdownToProseMirror,
  outline,
  parseVersion,
  proseMirrorToMarkdown,
  replaceSection,
  replaceTextInDoc,
  sectionToMarkdown,
  textResult,
  unwrap,
  type Json,
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

const PAGE = "intro\n\n# A\n\na1\n\n## B\n\nb1\n\n### C\n\nc1\n\n## B2\n\nlast\n\n## Notes\n\nn1\n\n## Notes\n\nn2";
const pageDoc = () => markdownToProseMirror(PAGE);

test("outline lists headings with offsets into the Markdown body", () => {
  const md = proseMirrorToMarkdown(pageDoc());
  const found = outline(pageDoc());
  assert.deepEqual(found.map((h) => [h.level, h.text]), [[1, "A"], [2, "B"], [3, "C"], [2, "B2"], [2, "Notes"], [2, "Notes"]]);
  for (const h of found) {
    assert.ok(md.slice(h.offset).startsWith(`${"#".repeat(h.level)} ${h.text}`));
  }
});

test("findSection runs to the next heading of the same or higher level", () => {
  const doc = pageDoc();
  assert.equal(sectionToMarkdown(doc, findSection(doc, "B")), "## B\n\nb1\n\n### C\n\nc1");
  assert.equal(sectionToMarkdown(doc, findSection(doc, "### C")), "### C\n\nc1");
  assert.equal(sectionToMarkdown(doc, findSection(doc, "b2")), "## B2\n\nlast");
});

test("findSection runs to the end of the page for the last section", () => {
  const doc = markdownToProseMirror("# A\n\na\n\n## Last\n\nz");
  assert.equal(sectionToMarkdown(doc, findSection(doc, "Last")), "## Last\n\nz");
});

test("findSection refuses a missing, mis-levelled or duplicate heading", () => {
  const doc = pageDoc();
  assert.throws(() => findSection(doc, "Nope"), /not found.*"## B"/);
  assert.throws(() => findSection(doc, "### B"), /not found/);
  assert.throws(() => findSection(doc, "Notes"), /matches 2 sections/);
});

const t = (text: string, marks?: unknown[]) => ({ type: "text", text, ...(marks ? { marks } : {}) });
const para = (...content: unknown[]) => ({ type: "paragraph", attrs: { id: "x" }, content });
const bold = [{ type: "bold" }];
const editDoc = () => ({
  type: "doc",
  content: [
    para(t("Intro text.")),
    para(t("Alpha "), t("bold", bold), t(" word.")),
    { type: "callout", content: [para(t("Note: keep this."))] },
    para(t("Tail "), { type: "hardBreak" }, t("end")),
  ],
});

test("replaceTextInDoc edits one run and leaves other blocks identical", () => {
  const before = editDoc();
  const { doc, count } = replaceTextInDoc(before, "Intro text.", "Hello.");
  const kids = doc.content as unknown[];
  assert.equal(count, 1);
  assert.deepEqual(kids[0], para(t("Hello.")));
  assert.equal(JSON.stringify(kids.slice(1)), JSON.stringify(editDoc().content.slice(1)));
  assert.deepEqual(before, editDoc(), "input is not mutated");
});

test("replaceTextInDoc across formatted runs keeps the first run's marks and the tail", () => {
  const { doc } = replaceTextInDoc(editDoc(), "pha bol", "X");
  assert.deepEqual((doc.content as Json[])[1], para(t("AlX"), t("d", bold), t(" word.")));
});

test("replaceTextInDoc reaches into nested blocks and never spans a break node", () => {
  const nested = replaceTextInDoc(editDoc(), "keep this", "drop that");
  assert.match(JSON.stringify(nested.doc), /Note: drop that\./);
  assert.throws(() => replaceTextInDoc(editDoc(), "Tail end", "x"), /not found/);
});

test("replaceTextInDoc refuses empty, missing and ambiguous matches unless replace_all", () => {
  assert.throws(() => replaceTextInDoc(editDoc(), "", "x"), /must not be empty/);
  assert.throws(() => replaceTextInDoc(editDoc(), "nope", "x"), /not found/);
  assert.throws(() => replaceTextInDoc(editDoc(), "t", "T"), /matches \d+ places/);
  const all = replaceTextInDoc(editDoc(), "ext", "EXT", true);
  assert.equal(all.count, 1);
  const two = replaceTextInDoc(editDoc(), "a", "A", true);
  assert.equal(two.count, 2);
  assert.match(JSON.stringify(two.doc), /AlphA.*TAil/);
});

const stamped = () => {
  const doc = markdownToProseMirror("intro\n\n# A\n\na1\n\n## B\n\nb1\n\n### C\n\nc1\n\n## D\n\nd1");
  (doc.content as Json[]).forEach((n, i) => (n.attrs = { ...(n.attrs as Json), id: `keep${i}` }));
  return doc;
};
const md = (d: Json) => proseMirrorToMarkdown(d);

test("replaceSection keeps the heading, swaps the body and subsections, leaves the rest identical", () => {
  const before = stamped();
  const after = replaceSection(before, "## B", "new body\n\n- x\n- y");
  assert.equal(md(after), "intro\n\n# A\n\na1\n\n## B\n\nnew body\n\n- x\n- y\n\n## D\n\nd1");
  const kept = (d: Json) => JSON.stringify([(d.content as Json[])[0], (d.content as Json[])[1], (d.content as Json[])[2], (d.content as Json[]).at(-2), (d.content as Json[]).at(-1)]);
  assert.equal(kept(after), kept(stamped()));
  const fresh = JSON.stringify((after.content as Json[])[4]);
  assert.match(fresh, /"id":"[a-z]{12}"/);
  assert.equal(md(replaceSection(stamped(), "## B", "")), "intro\n\n# A\n\na1\n\n## B\n\n## D\n\nd1");
  assert.equal(md(before), md(stamped()), "input is not mutated");
});

test("insertAfterSection lands after subsections and before the next heading", () => {
  assert.equal(md(insertAfterSection(stamped(), "B", "added")), "intro\n\n# A\n\na1\n\n## B\n\nb1\n\n### C\n\nc1\n\nadded\n\n## D\n\nd1");
  assert.throws(() => insertAfterSection(stamped(), "B", "  "), /must not be empty/);
});

test("insertInSection adds blocks at the start or at the end of a section's own body", () => {
  assert.equal(md(insertInSection(stamped(), "B", "added", "end")), "intro\n\n# A\n\na1\n\n## B\n\nb1\n\nadded\n\n### C\n\nc1\n\n## D\n\nd1");
  assert.equal(md(insertInSection(stamped(), "B", "added", "start")), "intro\n\n# A\n\na1\n\n## B\n\nadded\n\nb1\n\n### C\n\nc1\n\n## D\n\nd1");
  assert.equal(md(insertInSection(stamped(), "B", "added")), md(insertInSection(stamped(), "B", "added", "end")), "end is the default");
  assert.equal(md(insertInSection(stamped(), "D", "added")), "intro\n\n# A\n\na1\n\n## B\n\nb1\n\n### C\n\nc1\n\n## D\n\nd1\n\nadded", "no subsection: end of the section");
  assert.equal(md(insertInSection(stamped(), "A", "added")), "intro\n\n# A\n\na1\n\nadded\n\n## B\n\nb1\n\n### C\n\nc1\n\n## D\n\nd1");
  assert.throws(() => insertInSection(stamped(), "B", " "), /must not be empty/);
  assert.throws(() => insertInSection(stamped(), "B", "x", "middle"), /at must be/);
});

test("text added with insertInSection survives deleting the subsection that follows it", () => {
  const kept = deleteSection(insertInSection(stamped(), "B", "added"), "### C");
  assert.equal(md(kept), "intro\n\n# A\n\na1\n\n## B\n\nb1\n\nadded\n\n## D\n\nd1");
  const viaEdits = applyEdits(stamped(), [{ mode: "insert_in_section", heading: "B", markdown: "added", at: "start" }]);
  assert.match(md(viaEdits.doc), /## B\n\nadded\n\nb1/);
});

test("deleteSection removes the heading, body and subsections only", () => {
  assert.equal(md(deleteSection(stamped(), "## B")), "intro\n\n# A\n\na1\n\n## D\n\nd1");
  assert.equal(md(deleteSection(stamped(), "D")), "intro\n\n# A\n\na1\n\n## B\n\nb1\n\n### C\n\nc1");
});

test("section edits refuse Markdown the local converter cannot represent", () => {
  const cases: [string, string][] = [
    ["| a | b |\n|---|---|\n| 1 | 2 |", "table"],
    ["> quoted", "blockquote"],
    ["![alt](http://x/y.png)", "image"],
    ["- a\n  - nested", "nested list"],
    ["- [ ] todo", "task list"],
    ["---", "horizontal rule"],
    [":::info\nhi\n:::", "callout"],
  ];
  for (const [source, name] of cases) {
    assert.throws(() => replaceSection(stamped(), "B", source), new RegExp(`Unsupported Markdown: ${name}`));
  }
  assert.doesNotThrow(() => replaceSection(stamped(), "B", "```md\n| not | a table |\n```"));
});

test("textResult is compact, drops null fields, keeps array slots and plain strings", () => {
  const text = (v: unknown) => textResult(v).content[0]?.text;
  assert.equal(text({ a: 1, b: null, c: { d: null, e: "x" }, f: [1, null] }), '{"a":1,"c":{"e":"x"},"f":[1,null]}');
  assert.equal(text("already text"), "already text");
});

test("generatePosition returns a 5-12 character key", () => {
  const first = generatePosition(null, null);
  const after = generatePosition("a0000", null);
  assert.ok(first.length >= 5 && first.length <= 12);
  assert.ok(after.length >= 5 && after.length <= 12);
  assert.notEqual(first, after);
});
