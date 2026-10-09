import assert from "node:assert/strict";
import test from "node:test";
import { DocmostClient } from "./client.js";

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
