// Measures AI-facing output size through the real MCP tool path.
//   npm run measure                  compare with scripts/baseline.json
//   npm run measure -- --write-baseline   (only on the unmodified 1.0.1 code)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, writeFileSync } from "node:fs";
import { DocmostClient } from "../src/client.js";
import { registerTools } from "../src/tools.js";

const here = (p: string) => new URL(p, import.meta.url);
const ITEMS = 50; // fixture items are repeated to a full default page of 50
const SPACE = "0192f1a2-3b4c-7d5e-8f60-123456789abc";

const fixture = JSON.parse(readFileSync(here("./fixtures/list_pages_recent.json"), "utf8")) as {
  items: Record<string, unknown>[];
  meta?: unknown;
};
const items = Array.from({ length: ITEMS }, (_, i) => ({
  ...fixture.items[i % fixture.items.length],
  title: `Page ${i}`,
}));

const docmost = new DocmostClient({
  baseUrl: "http://docmost.test",
  authToken: "token",
  sessionPath: "unused",
  readOnly: false,
});
docmost.request = (async () => ({ items, meta: fixture.meta })) as DocmostClient["request"];

const server = new McpServer({ name: "measure", version: "0" });
registerTools(server, docmost);
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "measure", version: "0" });
await Promise.all([server.connect(a), client.connect(b)]);

const { tools } = await client.listTools();
const listed = (await client.callTool({
  name: "list_pages",
  arguments: { space_id: SPACE, limit: ITEMS },
})) as { content: { text: string }[] };

const now = {
  toolCount: tools.length,
  toolsListChars: JSON.stringify(tools).length,
  listPagesChars: listed.content[0]?.text.length ?? 0,
};

if (process.argv.includes("--write-baseline")) {
  writeFileSync(here("./baseline.json"), `${JSON.stringify(now, null, 2)}\n`);
  console.log("baseline written", now);
} else {
  const base = JSON.parse(readFileSync(here("./baseline.json"), "utf8")) as typeof now;
  const pct = (n: number, o: number) => `${n > o ? "+" : ""}${(((n - o) / o) * 100).toFixed(1)}%`;
  const row = (label: string, n: number, o: number) =>
    console.log(`${label.padEnd(22)} ${String(n).padStart(7)}  (baseline ${o}, ${pct(n, o)})`);
  row("tools", now.toolCount, base.toolCount);
  row("tools/list chars", now.toolsListChars, base.toolsListChars);
  row(`list_pages x${ITEMS} chars`, now.listPagesChars, base.listPagesChars);
  console.log(`~tokens (chars/3.5, rough): tools/list ${Math.round(now.toolsListChars / 3.5)}, list_pages ${Math.round(now.listPagesChars / 3.5)}`);
}
process.exit(0);
