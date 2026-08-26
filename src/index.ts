#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DocmostClient } from "./client.js";
import { loadConfig } from "./config.js";
import { ConfigError } from "./errors.js";
import { registerTools } from "./tools.js";

const PACKAGE_VERSION = "1.0.0";

function createServer(): McpServer {
  const config = loadConfig();
  const client = new DocmostClient(config);
  const server = new McpServer({
    name: "docmost-community-mcp",
    version: PACKAGE_VERSION,
  });
  registerTools(server, client);
  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError || error instanceof Error
    ? error.message
    : String(error);
  console.error(message);
  process.exit(1);
});
