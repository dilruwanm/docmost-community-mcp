import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DocmostClient } from "./client.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools.js";
import { readFileSync } from "node:fs";
import { MAX_CONTENT_CHARS, markdownToProseMirror, pageSummary, proseMirrorToMarkdown, textResult, type Json } from "./util.js";

const BODY = "intro\n\n# A\n\na1\n\n## B\n\nb1\n\n### C\n\nc1\n\n## D\n\nd1";
const doc = () => markdownToProseMirror(BODY);

async function connect(respond?: (path: string, body: any) => unknown): Promise<{ call: (name: string, args: Json) => Promise<{ isError?: boolean; data: any }>; formats: unknown[] }> {
  const docmost = new DocmostClient({ baseUrl: "http://docmost.test", authToken: "t", sessionPath: "unused", readOnly: false });
  const formats: unknown[] = [];
  docmost.request = (async (path: string, body?: any) => {
    formats.push(body?.format);
    if (respond) {
      return respond(path, body);
    }
    const content = body?.format === "json" ? doc() : proseMirrorToMarkdown(doc());
    return { id: "0192f1a2-3b4c-7d5e-8f60-123456789abc", slugId: "aB3dE5fG7h", title: "T", updatedAt: "u", content };
  }) as DocmostClient["request"];
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, docmost);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Json) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = r.content[0]?.text ?? "";
    return { isError: r.isError, data: r.isError ? text : JSON.parse(text) };
  };
  return { call, formats };
}

test("get_page without the new params returns the Markdown body unchanged", async () => {
  const { call } = await connect();
  const { data } = await call("get_page", { page_id: "aB3dE5fG7h" });
  assert.equal(data.content, proseMirrorToMarkdown(doc()));
  assert.equal("total_chars" in data, false);
});

test("get_page outline returns headings only, read as JSON", async () => {
  const { call, formats } = await connect();
  const { data } = await call("get_page", { page_id: "aB3dE5fG7h", outline: true });
  assert.deepEqual(data.outline.map((h: Json) => h.text), ["A", "B", "C", "D"]);
  assert.equal("content" in data, false);
  assert.deepEqual(formats, ["json"]);
});

test("get_page heading returns one section and an outline offset lands on its heading", async () => {
  const { call } = await connect();
  const section = await call("get_page", { page_id: "aB3dE5fG7h", heading: "## B" });
  assert.equal(section.data.content, "## B\n\nb1\n\n### C\n\nc1");
  const { data } = await call("get_page", { page_id: "aB3dE5fG7h", outline: true });
  const b = data.outline.find((h: Json) => h.text === "B");
  const paged = await call("get_page", { page_id: "aB3dE5fG7h", offset: b.offset, max_chars: 4 });
  assert.equal(paged.data.content, "## B");
});

test("get_page max_chars and offset reassemble the body exactly by following next_offset", async () => {
  const { call } = await connect();
  let text = "";
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const { data } = await call("get_page", { page_id: "aB3dE5fG7h", max_chars: 7, offset });
    text += data.content;
    offset = data.next_offset;
  }
  assert.equal(text, proseMirrorToMarkdown(doc()));
});

test("get_page refuses ambiguous or unsupported combinations", async () => {
  const { call } = await connect();
  assert.match((await call("get_page", { page_id: "x", outline: true, heading: "A" })).data, /either outline or heading/);
  assert.match((await call("get_page", { page_id: "x", format: "json", max_chars: 5 })).data, /need format markdown or html/);
  assert.match((await call("get_page", { page_id: "x", heading: "Nope" })).data, /Heading not found/);
});

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../scripts/fixtures/${name}.json`, import.meta.url), "utf8"));
// What 1.0.1 would have printed for a value, after the compact/null rules of textResult.
const asPrinted = (v: unknown) => JSON.parse(textResult(v).content[0]?.text ?? "");
const SLIM_ITEM = ["hasChildren", "icon", "id", "parentPageId", "slugId", "title", "updatedAt"];

test("list_pages is slim by default: one shared space, slim items, far fewer characters", async () => {
  const recent = fixture("list_pages_recent");
  const { call } = await connect(() => recent);
  const slim = await call("list_pages", { space_id: "0192f1a2-3b4c-7d5e-8f60-123456789abc" });
  assert.deepEqual(slim.data.space, recent.items[0].space);
  for (const item of slim.data.items) {
    assert.ok(Object.keys(item).every((k) => SLIM_ITEM.includes(k)), Object.keys(item).join());
  }
  const full = await call("list_pages", { space_id: "0192f1a2-3b4c-7d5e-8f60-123456789abc", verbose: true });
  assert.ok(JSON.stringify(slim.data).length < JSON.stringify(full.data).length / 2);
});

test("verbose restores every field the 1.0.1 list and write results had", async () => {
  const recent = fixture("list_pages_recent");
  const ackPage = fixture("update_page_ack");
  const { call } = await connect((path) => (path === "/pages/recent" ? recent : ackPage));
  const list = await call("list_pages", { space_id: "0192f1a2-3b4c-7d5e-8f60-123456789abc", verbose: true });
  assert.deepEqual(list.data.items, asPrinted(recent.items.map(pageSummary)));
  const slimUpdate = await call("update_page", { page_id: "aB3dE5fG7h", title: "T" });
  assert.deepEqual(Object.keys(slimUpdate.data).sort(), ["id", "slugId", "title", "updatedAt"]);
  const fullUpdate = await call("update_page", { page_id: "aB3dE5fG7h", title: "T", verbose: true });
  assert.deepEqual(fullUpdate.data, asPrinted(pageSummary(ackPage)));
});

test("search_pages names each item's space only when unscoped, and verbose keeps it", async () => {
  const found = fixture("search_pages");
  const { call } = await connect(() => found);
  const unscoped = await call("search_pages", { query: "spike" });
  assert.ok(unscoped.data.items.every((i: Json) => i.space && !("spaceId" in i)));
  const scoped = await call("search_pages", { query: "spike", space_id: "0192f1a2-3b4c-7d5e-8f60-123456789abc" });
  assert.ok(scoped.data.items.every((i: Json) => !("space" in i) && !("spaceId" in i)));
  const full = await call("search_pages", { query: "spike", verbose: true });
  assert.ok(full.data.items.every((i: Json) => "space" in i)); // v0.96 search items carry space, not spaceId
});

test("pass-through tools are slim by default and verbose returns the server payload", async () => {
  const keys = (v: Json) => Object.keys(v).sort();
  const cases: { tool: string; args: Json; fixture: string; check: (d: any) => void }[] = [
    { tool: "duplicate_page", args: { page_id: "0192f1a2-3b4c-7d5e-8f60-123456789abc" }, fixture: "duplicate_page",
      check: (d) => assert.ok(keys(d).every((k) => ["id", "slugId", "title", "updatedAt", "parentPageId", "childPageIds"].includes(k))) },
    { tool: "get_breadcrumbs", args: { page_id: "0192f1a2-3b4c-7d5e-8f60-123456789abc" }, fixture: "get_breadcrumbs",
      check: (d) => d.forEach((p: Json) => assert.ok(keys(p).every((k) => ["id", "slugId", "title", "icon"].includes(k)))) },
    { tool: "search_suggest", args: { query: "T1" }, fixture: "search_suggest",
      check: (d) => d.pages.forEach((p: Json) => assert.ok(!("spaceId" in p) && "space" in p)) },
    { tool: "list_space_members", args: { space_id: "0192f1a2-3b4c-7d5e-8f60-123456789abc" }, fixture: "list_space_members",
      check: (d) => d.items.forEach((m: Json) => assert.ok(!("avatarUrl" in m) && !("createdAt" in m) && "role" in m)) },
  ];
  for (const c of cases) {
    const payload = fixture(c.fixture);
    const { call } = await connect(() => payload);
    const slim = await call(c.tool, c.args);
    c.check(slim.data);
    const full = await call(c.tool, { ...c.args, verbose: true });
    assert.ok(JSON.stringify(full.data).length > JSON.stringify(slim.data).length, `${c.tool}: verbose is larger`);
    const expected = c.tool === "list_space_members" ? asItemsLike(payload) : payload;
    assert.deepEqual(full.data, asPrinted(expected), `${c.tool}: verbose equals the server payload`);
  }
});

const asItemsLike = (payload: { items: unknown[]; meta?: unknown }) => ({ items: payload.items, meta: payload.meta });

test("list_workspace_members and get_current_user drop settings and timestamps unless verbose", async () => {
  const member = { id: "m1", name: "A", email: "a@example.com", role: "member", settings: { x: 1 }, locale: "en-US", lastLoginAt: "2026-01-01", workspaceId: "w" };
  const me = { user: { ...member, workspaceId: "w" }, workspace: { id: "w", name: "W", defaultSpaceId: "s", memberCount: 2, settings: { y: 1 }, stripeCustomerId: "c" } };
  const { call } = await connect((path) => (path === "/users/me" ? me : { items: [member], meta: {} }));
  const members = await call("list_workspace_members", {});
  assert.deepEqual(members.data.items[0], { id: "m1", name: "A", email: "a@example.com", role: "member" });
  assert.deepEqual((await call("list_workspace_members", { verbose: true })).data.items[0], member);
  const slim = await call("get_current_user", {});
  assert.deepEqual(Object.keys(slim.data.workspace).sort(), ["defaultSpaceId", "id", "memberCount", "name"]);
  assert.ok("readOnly" in slim.data, "keeps the version and read-only info");
  assert.ok("stripeCustomerId" in (await call("get_current_user", { verbose: true })).data.workspace);
});

const BIG = Array.from({ length: 4000 }, (_, i) => `paragraph number ${i} with some filler text`).join("\n\n");

test("get_page caps a very long body and following next_offset reassembles it exactly", async () => {
  assert.ok(BIG.length > 2 * MAX_CONTENT_CHARS);
  const { call } = await connect(() => ({ id: "i", slugId: "s", title: "T", updatedAt: "u", content: BIG }));
  const first = await call("get_page", { page_id: "0192f1a2-3b4c-7d5e-8f60-123456789abc" });
  assert.equal(first.data.content.length, MAX_CONTENT_CHARS);
  assert.equal(first.data.truncated, true);
  assert.equal(first.data.total_chars, BIG.length);
  let text = "";
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const { data } = await call("get_page", { page_id: "0192f1a2-3b4c-7d5e-8f60-123456789abc", offset });
    text += data.content;
    offset = data.next_offset;
  }
  assert.equal(text, BIG);
});

test("get_page leaves a body under the cap untouched, with no paging fields", async () => {
  const { call } = await connect(() => ({ id: "i", title: "T", content: "short body" }));
  const { data } = await call("get_page", { page_id: "0192f1a2-3b4c-7d5e-8f60-123456789abc" });
  assert.equal(data.content, "short body");
  assert.ok(!("truncated" in data) && !("total_chars" in data));
});

test("get_history_version caps string content, pages by offset, and leaves object content alone", async () => {
  const id = "0192f1a2-3b4c-7d5e-8f60-123456789abc";
  const big = await connect(() => ({ id, content: BIG }));
  const first = await big.call("get_history_version", { history_id: id });
  assert.equal(first.data.content.length, MAX_CONTENT_CHARS);
  assert.equal(first.data.next_offset, MAX_CONTENT_CHARS);
  const rest = await big.call("get_history_version", { history_id: id, offset: first.data.next_offset, max_chars: BIG.length });
  assert.equal(first.data.content + rest.data.content, BIG);
  assert.ok(!("truncated" in rest.data));
  const obj = await connect(() => ({ id, content: { type: "doc", content: [] } }));
  assert.deepEqual((await obj.call("get_history_version", { history_id: id })).data.content, { type: "doc", content: [] });
});

async function toolNames(toolsets?: Parameters<typeof registerTools>[2]): Promise<string[]> {
  const docmost = new DocmostClient({ baseUrl: "http://docmost.test", authToken: "t", sessionPath: "unused", readOnly: false });
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, docmost, toolsets);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return (await client.listTools()).tools.map((t) => t.name);
}

test("with no toolsets every tool is registered; a subset registers only its groups", async () => {
  const all = await toolNames();
  for (const name of ["search_pages", "edit_page", "list_spaces", "get_comments", "search_suggest", "get_current_user", "upload_attachment", "list_page_labels", "list_space_members"]) {
    assert.ok(all.includes(name), name);
  }
  const some = await toolNames(["comments", "pages"]);
  assert.ok(some.includes("edit_page") && some.includes("get_comments"));
  assert.ok(!some.includes("list_spaces") && !some.includes("list_space_members") && !some.includes("get_current_user"));
  assert.ok(some.length < all.length);
  assert.deepEqual(await toolNames(["comments", "pages"]), await toolNames(["pages", "comments"]), "order does not matter");
});

test("DOCMOST_TOOLSETS is parsed, case-insensitive, and rejects unknown names", () => {
  const saved = { ...process.env };
  try {
    process.env.DOCMOST_URL = "http://docmost.test";
    process.env.DOCMOST_AUTH_TOKEN = "t";
    delete process.env.DOCMOST_TOOLSETS;
    assert.equal(loadConfig().toolsets, undefined);
    process.env.DOCMOST_TOOLSETS = " Pages, comments ,";
    assert.deepEqual(loadConfig().toolsets, ["pages", "comments"]);
    process.env.DOCMOST_TOOLSETS = "pages,page,foo";
    assert.throws(() => loadConfig(), /Unknown DOCMOST_TOOLSETS: page, foo\. Valid names: pages, spaces/);
  } finally {
    process.env = saved;
  }
});
