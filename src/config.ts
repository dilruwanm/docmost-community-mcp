import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./errors.js";

export const TOOLSET_NAMES = [
  "pages",
  "spaces",
  "comments",
  "search",
  "workspace",
  "attachments",
  "labels",
  "members",
] as const;
export type ToolsetName = (typeof TOOLSET_NAMES)[number];

export type DocmostConfig = {
  baseUrl: string;
  email?: string;
  password?: string;
  authToken?: string;
  sessionPath: string;
  readOnly: boolean;
  toolsets?: ToolsetName[];
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConfigError(`Missing required environment variable ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function optionalFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

// Unset means every tool. Unknown names fail at startup instead of silently hiding tools.
function toolsets(): ToolsetName[] | undefined {
  const names = (optional("DOCMOST_TOOLSETS") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const unknown = names.filter((name) => !(TOOLSET_NAMES as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown DOCMOST_TOOLSETS: ${unknown.join(", ")}. Valid names: ${TOOLSET_NAMES.join(", ")}`,
    );
  }
  return names.length > 0 ? (names as ToolsetName[]) : undefined;
}

export function loadConfig(): DocmostConfig {
  const rawUrl = required("DOCMOST_URL").replace(/\/+$/, "");
  const baseUrl = rawUrl.replace(/\/api$/i, "");
  const email = optional("DOCMOST_EMAIL");
  const password = optional("DOCMOST_PASSWORD");
  const authToken = optional("DOCMOST_AUTH_TOKEN");

  if (!authToken && (!email || !password)) {
    throw new ConfigError(
      "Set DOCMOST_EMAIL and DOCMOST_PASSWORD, or DOCMOST_AUTH_TOKEN",
    );
  }

  return {
    baseUrl,
    email,
    password,
    authToken,
    sessionPath:
      optional("DOCMOST_SESSION_PATH") ??
      join(homedir(), ".docmost-community-mcp", "session.json"),
    readOnly: optionalFlag("DOCMOST_READ_ONLY"),
    toolsets: toolsets(),
  };
}
