import assert from "node:assert/strict";
import test from "node:test";
import { DocmostClient } from "./client.js";
import { applyEdits, type PageEdit } from "./util.js";

const UUID = "0192f1a2-3b4c-7d5e-8f60-123456789abc";

function stubClient(page: unknown): { client: DocmostClient; calls: unknown[] } {
  const client = new DocmostClient({
    baseUrl: "http://docmost.test",
    authToken: "token",
    sessionPath: "unused",
    readOnly: false,
  });
  const calls: unknown[] = [];
  client.request = (async (path: string, body?: unknown) => {
    calls.push({ path, body });
    return page;
  }) as DocmostClient["request"];
  return { client, calls };
}

test("resolvePageId passes UUIDs through without a lookup", async () => {
  const { client, calls } = stubClient(undefined);
  assert.equal(await client.resolvePageId(UUID), UUID);
  assert.equal(calls.length, 0);
});

test("resolvePageId resolves a slugId via /pages/info", async () => {
  const { client, calls } = stubClient({ id: UUID, slugId: "aB3dE5fG7h" });
  assert.equal(await client.resolvePageId("aB3dE5fG7h"), UUID);
  assert.deepEqual(calls, [{ path: "/pages/info", body: { pageId: "aB3dE5fG7h" } }]);
});

test("resolvePageId reports a missing page by the value given", async () => {
  const { client } = stubClient(undefined);
  await assert.rejects(client.resolvePageId("missing"), /Page not found: missing/);
});

const SLUG = "aB3dE5fG7h";
const para = (id: string, text: string) => ({
  type: "paragraph",
  attrs: { id },
  content: [{ type: "text", text }],
});
const pageDoc = () => ({
  type: "doc",
  content: [
    { type: "heading", attrs: { id: "h1", level: 2 }, content: [{ type: "text", text: "Intro" }] },
    para("p1", "Hello world."),
    { type: "heading", attrs: { id: "h2", level: 2 }, content: [{ type: "text", text: "Next" }] },
    para("p2", "Keep me."),
  ],
});

function editClient(readOnly = false): { client: DocmostClient; writes: { path: string; body: any }[] } {
  const client = new DocmostClient({
    baseUrl: "http://docmost.test",
    authToken: "token",
    sessionPath: "unused",
    readOnly,
  });
  const writes: { path: string; body: any }[] = [];
  (client as unknown as { writeChecked: boolean }).writeChecked = true; // skip the version probe
  client.request = (async (path: string, body?: any) => {
    if (path === "/pages/info") {
      return { id: UUID, slugId: SLUG, title: "T", updatedAt: "2026-11-21T12:00:00.000Z", content: pageDoc() };
    }
    writes.push({ path, body });
    return { id: UUID, slugId: SLUG, title: "T", updatedAt: "2026-11-21T12:05:00.000Z" };
  }) as DocmostClient["request"];
  return { client, writes };
}

test("editPage reads by slugId and writes one JSON replace with untouched blocks as read", async () => {
  const { client, writes } = editClient();
  const result = await client.editPage(SLUG, [
    { mode: "replace_text", old_text: "Hello world.", new_text: "Hi." },
    { mode: "insert_after_section", heading: "Intro", markdown: "added" },
  ]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.path, "/pages/update");
  assert.equal(writes[0]?.body.pageId, UUID);
  assert.equal(writes[0]?.body.format, "json");
  assert.equal(writes[0]?.body.operation, "replace");
  const sent = writes[0]?.body.content.content;
  assert.deepEqual(sent[1], para("p1", "Hi."));
  assert.deepEqual(sent[3], pageDoc().content[2]);
  assert.deepEqual(sent.at(-1), pageDoc().content[3]);
  assert.equal(result.updatedAt, "2026-11-21T12:05:00.000Z");
});

test("editPage writes nothing when any edit fails and names the edit", async () => {
  const { client, writes } = editClient();
  await assert.rejects(
    client.editPage(UUID, [
      { mode: "replace_text", old_text: "Hello world.", new_text: "Hi." },
      { mode: "delete_section", heading: "Missing" },
    ]),
    /Edit #2 \(delete_section\) failed, nothing was written.*not found/,
  );
  assert.equal(writes.length, 0);
});

test("editPage refuses a stale expected_updated_at and accepts a matching one", async () => {
  const { client, writes } = editClient();
  const edit = [{ mode: "replace_text" as const, old_text: "Keep me.", new_text: "Kept." }];
  await assert.rejects(client.editPage(UUID, edit, "2026-11-21T11:59:59.000Z"), /Page changed since/);
  assert.equal(writes.length, 0);
  await client.editPage(UUID, edit, "2026-11-21T12:00:00Z");
  assert.equal(writes.length, 1);
});

test("editPage refuses to run when DOCMOST_READ_ONLY is set", async () => {
  const { client, writes } = editClient(true);
  await assert.rejects(
    client.editPage(UUID, [{ mode: "delete_section", heading: "Intro" }]),
    /DOCMOST_READ_ONLY/,
  );
  assert.equal(writes.length, 0);
});

test("applyEdits reports what each edit changed and requires its fields", () => {
  assert.throws(
    () => editClientApply({ mode: "replace_section", heading: "Intro" }),
    /Edit #1 \(replace_section\).*markdown is required/,
  );
});

function editClientApply(edit: PageEdit) {
  return applyEdits(pageDoc(), [edit]);
}
