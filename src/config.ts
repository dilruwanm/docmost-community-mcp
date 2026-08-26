import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./errors.js";

export type DocmostConfig = {
  baseUrl: string;
  email?: string;
  password?: string;
  authToken?: string;
  sessionPath: string;
  readOnly: boolean;
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
  };
}
