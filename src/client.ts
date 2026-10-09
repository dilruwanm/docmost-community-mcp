import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { DocmostConfig } from "./config.js";
import { ConfigError, DocmostError, VersionError } from "./errors.js";
import {
  asItems,
  compareSemver,
  decodeJwtExpiry,
  generatePosition,
  markdownToProseMirror,
  parseVersion,
  readSession,
  type Json,
  unwrap,
  writeSession,
} from "./util.js";

export const MIN_WRITE_VERSION = "0.71.0";
const USER_AGENT = "docmost-community-mcp/1.0.0";

export type Pagination = {
  limit?: number;
  cursor?: string;
};

export class DocmostClient {
  private token: string | undefined;
  private versionProbe:
    | { probed: true; version?: string; error?: string }
    | { probed: false } = { probed: false };
  private writeChecked = false;

  constructor(private readonly config: DocmostConfig) {
    this.token = config.authToken;
  }

  apiUrl(path: string): string {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${this.config.baseUrl}/api${suffix}`;
  }

  async ensureSession(): Promise<void> {
    if (!this.token) {
      this.token = await readSession(this.config.sessionPath, this.config.baseUrl);
    }
    if (this.token) {
      return;
    }
    await this.login();
  }

  async login(): Promise<void> {
    if (!this.config.email || !this.config.password) {
      throw new ConfigError(
        "Saved session is missing or expired. Set DOCMOST_EMAIL and DOCMOST_PASSWORD, or a fresh DOCMOST_AUTH_TOKEN",
      );
    }

    const response = await fetch(this.apiUrl("/auth/login"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({
        email: this.config.email,
        password: this.config.password,
      }),
    });

    const body = await this.parseBody(response);
    if (!response.ok) {
      throw this.toError("Login failed", response.status, body);
    }

    const payload = unwrap(body) as Json | undefined;
    if (payload && (payload.userHasMfa || payload.requiresMfaSetup)) {
      throw new ConfigError(
        "This account requires MFA. Community MCP cannot complete that flow. Sign in via the Docmost UI, copy the authToken cookie, and set DOCMOST_AUTH_TOKEN",
      );
    }

    const token = this.extractCookie(response, "authToken") ?? this.extractToken(body);
    if (!token) {
      throw new ConfigError("Login succeeded but no authToken cookie was returned");
    }

    this.token = token;
    await writeSession(this.config.sessionPath, {
      baseUrl: this.config.baseUrl,
      token,
      expiresAt: decodeJwtExpiry(token),
    });
  }

  async request<T = unknown>(
    path: string,
    body?: unknown,
    options: { retry?: boolean; raw?: boolean } = {},
  ): Promise<T> {
    await this.ensureSession();

    const response = await fetch(this.apiUrl(path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": USER_AGENT,
        cookie: `authToken=${this.token}`,
      },
      body: JSON.stringify(body ?? {}),
    });

    if (response.status === 401 && options.retry !== false) {
      this.token = undefined;
      await this.login();
      return this.request<T>(path, body, { ...options, retry: false });
    }

    if (options.raw) {
      if (!response.ok) {
        const errorBody = await this.parseBody(response);
        throw this.toError(`POST ${path} failed`, response.status, errorBody);
      }
      return response as T;
    }

    const payload = await this.parseBody(response);
    if (!response.ok) {
      throw this.toError(`POST ${path} failed`, response.status, payload);
    }
    return unwrap(payload) as T;
  }

  async multipart<T = unknown>(
    path: string,
    form: FormData,
    options: { retry?: boolean } = {},
  ): Promise<T> {
    await this.ensureSession();

    const response = await fetch(this.apiUrl(path), {
      method: "POST",
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        cookie: `authToken=${this.token}`,
      },
      body: form,
    });

    if (response.status === 401 && options.retry !== false) {
      this.token = undefined;
      await this.login();
      return this.multipart<T>(path, form, { retry: false });
    }

    const payload = await this.parseBody(response);
    if (!response.ok) {
      throw this.toError(`POST ${path} failed`, response.status, payload);
    }
    return unwrap(payload) as T;
  }

  get readOnly(): boolean {
    return this.config.readOnly;
  }

  assertMutable(): void {
    if (this.config.readOnly) {
      throw new ConfigError(
        "DOCMOST_READ_ONLY is enabled. This MCP session can search and read, but cannot create, update, move, or delete wiki content.",
      );
    }
  }

  async getVersion(): Promise<string | undefined> {
    const probe = await this.probeVersion();
    return probe.version;
  }

  async probeVersion(): Promise<{ version?: string; error?: string }> {
    if (this.versionProbe.probed) {
      return this.versionProbe;
    }

    try {
      const response = await this.request<Response>("/version", {}, { raw: true });
      const payload = await this.parseBody(response);
      const version =
        parseVersion(unwrap(payload)) ??
        parseVersion(payload) ??
        parseVersionFromHeaders(response.headers);
      if (!version) {
        const preview =
          typeof payload === "string" ? payload.slice(0, 180) : JSON.stringify(payload)?.slice(0, 180);
        this.versionProbe = {
          probed: true,
          error: `POST /api/version returned no currentVersion (${preview || "empty body"})`,
        };
      } else {
        this.versionProbe = { probed: true, version };
      }
    } catch (error) {
      this.versionProbe = {
        probed: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return this.versionProbe;
  }

  async sessionInfo(): Promise<{
    docmostVersion: string | null;
    versionProbeError: string | null;
    readOnly: boolean;
    markdownWritesSupported: boolean | null;
  }> {
    const probe = await this.probeVersion();
    return {
      docmostVersion: probe.version ?? null,
      versionProbeError: probe.error ?? null,
      readOnly: this.config.readOnly,
      markdownWritesSupported: probe.version
        ? compareSemver(probe.version, MIN_WRITE_VERSION) >= 0
        : null,
    };
  }

  async assertWritable(): Promise<string | undefined> {
    this.assertMutable();
    if (this.writeChecked) {
      return this.versionProbe.probed ? this.versionProbe.version : undefined;
    }
    const probe = await this.probeVersion();
    this.writeChecked = true;
    if (probe.version && compareSemver(probe.version, MIN_WRITE_VERSION) < 0) {
      throw new VersionError(
        `Docmost ${probe.version} cannot persist page bodies over REST. Upgrade to v${MIN_WRITE_VERSION} or later. Title-only updates still work.`,
      );
    }
    return probe.version;
  }

  async confirmMarkdownWrite(page: unknown, sentMarkdown: string): Promise<void> {
    if (!page || typeof page !== "object") {
      return;
    }
    const content = (page as Json).content;
    if (content && typeof content === "object") {
      throw new VersionError(
        "The server ignored format=markdown and returned ProseMirror JSON. This Docmost build is too old for in-place Markdown writes. Upgrade to v0.71+",
      );
    }
    if (typeof content === "string" && sentMarkdown.trim() && !content.trim()) {
      throw new DocmostError("Page update returned empty Markdown content");
    }
  }

  async resolveSpaceId(spaceIdOrSlug: string): Promise<string> {
    if (isUuid(spaceIdOrSlug)) {
      return spaceIdOrSlug;
    }
    const listed = asItems(await this.request("/spaces", { limit: 100 }));
    const match = listed.items.find((item) => {
      const space = item as Json;
      return space.slug === spaceIdOrSlug || space.id === spaceIdOrSlug;
    });
    if (!match) {
      throw new DocmostError(`Space not found: ${spaceIdOrSlug}`);
    }
    return String((match as Json).id);
  }

  // Only /pages/info and /pages/update accept a slugId; every other page
  // endpoint expects the UUID, so resolve before calling them.
  async resolvePageId(pageIdOrSlug: string): Promise<string> {
    if (isUuid(pageIdOrSlug)) {
      return pageIdOrSlug;
    }
    const page = (await this.request("/pages/info", { pageId: pageIdOrSlug })) as Json | undefined;
    if (!page || typeof page.id !== "string") {
      throw new DocmostError(`Page not found: ${pageIdOrSlug}`);
    }
    return page.id;
  }

  async computeMovePosition(input: {
    pageId: string;
    parentPageId?: string | null;
    position?: "first" | "last" | string;
    afterPageId?: string;
  }): Promise<string> {
    if (input.position && input.position !== "first" && input.position !== "last") {
      if (input.position.length < 5 || input.position.length > 12) {
        throw new DocmostError("position must be 5-12 characters, or first/last");
      }
      return input.position;
    }

    const siblings = asItems(
      await this.request("/pages/sidebar-pages", {
        pageId: input.parentPageId ?? undefined,
        spaceId: input.parentPageId ? undefined : ((await this.request("/pages/info", { pageId: input.pageId })) as Json).spaceId,
        limit: 100,
      }),
    ).items as Json[];

    const others = siblings.filter((page) => page.id !== input.pageId);
    if (input.afterPageId) {
      const index = others.findIndex((page) => page.id === input.afterPageId);
      const before = index >= 0 ? String(others[index]?.position ?? "") : undefined;
      const after = index >= 0 ? String(others[index + 1]?.position ?? "") : undefined;
      return generatePosition(before || null, after || null);
    }
    if (input.position === "first") {
      return generatePosition(null, others[0] ? String(others[0].position) : null);
    }
    const last = others[others.length - 1];
    return generatePosition(last ? String(last.position) : null, null);
  }

  commentContent(markdown: string): string {
    return JSON.stringify(markdownToProseMirror(markdown));
  }

  async uploadFile(pageId: string, filePath: string): Promise<unknown> {
    const bytes = await readFile(filePath);
    const fileName = basename(filePath);
    const form = new FormData();
    form.append("pageId", pageId);
    form.append(
      "file",
      new Blob([bytes]),
      fileName,
    );
    return this.multipart("/files/upload", form);
  }

  async importPage(input: {
    spaceId: string;
    title: string;
    markdown: string;
    parentPageId?: string;
  }): Promise<unknown> {
    const form = new FormData();
    form.append("spaceId", input.spaceId);
    if (input.parentPageId) {
      form.append("parentPageId", input.parentPageId);
    }
    const body = input.markdown.startsWith("#")
      ? input.markdown
      : `# ${input.title}\n\n${input.markdown}`;
    form.append(
      "file",
      new Blob([body], { type: "text/markdown" }),
      "import.md",
    );
    return this.multipart("/pages/import", form);
  }

  private extractCookie(response: Response, name: string): string | undefined {
    const headers = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
    for (const header of headers) {
      const match = header.match(new RegExp(`${name}=([^;]+)`));
      if (match?.[1]) {
        return match[1];
      }
    }
    return undefined;
  }

  private extractToken(body: unknown): string | undefined {
    const data = unwrap(body);
    if (!data || typeof data !== "object") {
      return undefined;
    }
    const record = data as Json;
    if (typeof record.authToken === "string") {
      return record.authToken;
    }
    if (typeof record.token === "string") {
      return record.token;
    }
    return undefined;
  }

  private async parseBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) {
      return undefined;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private toError(prefix: string, status: number, body: unknown): DocmostError {
    const data = unwrap(body);
    const message =
      (data && typeof data === "object" && typeof (data as Json).message === "string"
        ? (data as Json).message
        : typeof data === "string"
          ? data
          : JSON.stringify(data ?? {})) ?? "";
    return new DocmostError(`${prefix} (${status})${message ? `: ${message}` : ""}`, status, body);
  }
}

function parseVersionFromHeaders(headers: Headers): string | undefined {
  for (const name of ["x-docmost-version", "x-app-version"]) {
    const value = headers.get(name)?.trim();
    if (value) {
      const parsed = parseVersion(value);
      if (parsed) {
        return parsed;
      }
    }
  }
  return undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
