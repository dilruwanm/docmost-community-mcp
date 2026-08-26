import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Json = Record<string, unknown>;

export function unwrap(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const record = payload as Json;
  if ("data" in record && (record.success === true || record.status !== undefined)) {
    return record.data;
  }
  return payload;
}

export function asItems(payload: unknown): { items: unknown[]; meta?: Json } {
  const data = unwrap(payload);
  if (Array.isArray(data)) {
    return { items: data };
  }
  if (data && typeof data === "object") {
    const record = data as Json;
    if (Array.isArray(record.items)) {
      return {
        items: record.items,
        meta: (record.meta as Json | undefined) ?? undefined,
      };
    }
    if (record.data && typeof record.data === "object") {
      const inner = record.data as Json;
      if (Array.isArray(inner.items)) {
        return {
          items: inner.items,
          meta: (inner.meta as Json | undefined) ?? undefined,
        };
      }
      if (Array.isArray(inner)) {
        return { items: inner };
      }
    }
  }
  return { items: data == null ? [] : [data] };
}

export function parseVersion(input: unknown): string | undefined {
  if (typeof input === "string") {
    const trimmed = input.trim().replace(/^v/i, "");
    if (/^\d+\.\d+/.test(trimmed)) {
      return trimmed;
    }
    return undefined;
  }
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = unwrap(input) as Json;
  const candidates = [
    record.currentVersion,
    record.version,
    record.releaseVersion,
    record.appVersion,
    record.release,
    (record.plan as Json | undefined)?.version,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) {
      return value.replace(/^v/i, "");
    }
  }
  return undefined;
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part.replace(/\D.*/, ""), 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part.replace(/\D.*/, ""), 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export function decodeJwtExpiry(token: string): number | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) {
      return undefined;
    }
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: number;
    };
    return typeof json.exp === "number" ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export type SessionFile = {
  baseUrl: string;
  token: string;
  expiresAt?: number;
};

export async function readSession(path: string, baseUrl: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const session = JSON.parse(raw) as SessionFile;
    if (session.baseUrl !== baseUrl || !session.token) {
      return undefined;
    }
    if (session.expiresAt && session.expiresAt < Date.now() + 60_000) {
      return undefined;
    }
    return session.token;
  } catch {
    return undefined;
  }
}

export async function writeSession(path: string, session: SessionFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(session, null, 2), { mode: 0o600 });
}

export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return slug.length >= 2 ? slug : `space-${Date.now().toString(36)}`;
}

export function normalizeLabel(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_~-]/g, "");
}

export function markdownToProseMirror(markdown: string): Json {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Json[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (line.trimStart().startsWith("```")) {
      const language = line.trimStart().slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) {
        i += 1;
      }
      blocks.push({
        type: "codeBlock",
        attrs: language ? { language } : {},
        content: body.length > 0 ? [{ type: "text", text: body.join("\n") }] : [],
      });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      blocks.push({
        type: "heading",
        attrs: { level },
        content: inlineNodes(heading[2] ?? ""),
      });
      i += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: Json[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? "")) {
        items.push(listItem(inlineNodes((lines[i] ?? "").replace(/^\s*[-*+]\s+/, ""))));
        i += 1;
      }
      blocks.push({ type: "bulletList", content: items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: Json[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? "")) {
        items.push(listItem(inlineNodes((lines[i] ?? "").replace(/^\s*\d+[.)]\s+/, ""))));
        i += 1;
      }
      blocks.push({ type: "orderedList", content: items });
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !/^(#{1,6})\s+/.test(lines[i] ?? "") &&
      !(lines[i] ?? "").trimStart().startsWith("```") &&
      !/^\s*[-*+]\s+/.test(lines[i] ?? "") &&
      !/^\s*\d+[.)]\s+/.test(lines[i] ?? "")
    ) {
      paragraph.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push({
      type: "paragraph",
      content: inlineNodes(paragraph.join(" ")),
    });
  }

  return {
    type: "doc",
    content: blocks.length > 0 ? blocks : [{ type: "paragraph" }],
  };
}

function listItem(inline: Json[]): Json {
  return {
    type: "listItem",
    content: [{ type: "paragraph", content: inline }],
  };
}

function inlineNodes(text: string): Json[] {
  const nodes: Json[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) {
      nodes.push({ type: "text", text: text.slice(last, match.index) });
    }
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push({ type: "text", text: token.slice(1, -1), marks: [{ type: "code" }] });
    } else if (token.startsWith("**")) {
      nodes.push({ type: "text", text: token.slice(2, -2), marks: [{ type: "bold" }] });
    } else if (token.startsWith("[")) {
      nodes.push({
        type: "text",
        text: match[2] ?? token,
        marks: [{ type: "link", attrs: { href: match[3] ?? "" } }],
      });
    } else {
      nodes.push({ type: "text", text: token.slice(1, -1), marks: [{ type: "italic" }] });
    }
    last = match.index + token.length;
  }
  if (last < text.length) {
    nodes.push({ type: "text", text: text.slice(last) });
  }
  return nodes.filter((node) => typeof node.text !== "string" || node.text.length > 0);
}

export function proseMirrorToMarkdown(value: unknown): string {
  return renderPm(value).replace(/\n{3,}/g, "\n\n").trimEnd();
}

function renderPm(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object") {
        return renderPm(parsed);
      }
      return value;
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    return value.map((node) => renderPm(node)).filter(Boolean).join("\n\n");
  }
  if (typeof value !== "object") {
    return String(value);
  }

  const node = value as Json;
  const attrs = (node.attrs as Json | undefined) ?? {};
  const children = Array.isArray(node.content) ? (node.content as unknown[]) : [];

  if (node.type === "text" && typeof node.text === "string") {
    return applyMarks(node.text, node.marks);
  }
  if (node.type === "hardBreak") {
    return "\n";
  }
  if (node.type === "mention") {
    const label = typeof attrs.label === "string" ? attrs.label : "mention";
    return `@${label}`;
  }
  if (node.type === "heading") {
    const level = Math.min(Math.max(Number(attrs.level ?? 1), 1), 6);
    return `${"#".repeat(level)} ${children.map((child) => renderPm(child)).join("")}`;
  }
  if (node.type === "paragraph") {
    return children.map((child) => renderPm(child)).join("");
  }
  if (node.type === "codeBlock") {
    const language = typeof attrs.language === "string" ? attrs.language : "";
    const text = children.map((child) => renderPm(child)).join("");
    return `\`\`\`${language}\n${text}\n\`\`\``;
  }
  if (node.type === "bulletList") {
    return children.map((item) => `- ${listItemMarkdown(item)}`).join("\n");
  }
  if (node.type === "orderedList") {
    return children
      .map((item, index) => `${index + 1}. ${listItemMarkdown(item)}`)
      .join("\n");
  }
  if (node.type === "listItem" || node.type === "doc") {
    const joiner = node.type === "doc" ? "\n\n" : "\n";
    return children.map((child) => renderPm(child)).filter(Boolean).join(joiner);
  }
  return children.map((child) => renderPm(child)).join("");
}

function listItemMarkdown(item: unknown): string {
  return renderPm(item).replace(/\n+/g, " ").trim();
}

function applyMarks(text: string, marks: unknown): string {
  if (!Array.isArray(marks)) {
    return text;
  }
  let result = text;
  for (const mark of marks) {
    if (!mark || typeof mark !== "object") {
      continue;
    }
    const typed = mark as Json;
    if (typed.type === "code") {
      result = `\`${result}\``;
    } else if (typed.type === "bold" || typed.type === "strong") {
      result = `**${result}**`;
    } else if (typed.type === "italic" || typed.type === "em") {
      result = `*${result}*`;
    } else if (typed.type === "link") {
      const href = String(((typed.attrs as Json | undefined)?.href as string | undefined) ?? "");
      result = `[${result}](${href})`;
    }
  }
  return result;
}

export function exportFileName(input: {
  contentDisposition?: string | null;
  contentType?: string | null;
  bytes: Uint8Array;
  fallbackBase: string;
}): string {
  const header = input.contentDisposition ?? "";
  const match = header.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (match?.[1]) {
    return decodeURIComponent(match[1]);
  }
  return `${input.fallbackBase}${exportExtension(input.contentType, input.bytes)}`;
}

export function exportExtension(contentType: string | null | undefined, bytes: Uint8Array): string {
  if (isZip(bytes)) {
    return ".zip";
  }
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("html")) {
    return ".html";
  }
  if (ct.includes("zip")) {
    return ".zip";
  }
  return ".md";
}

function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  );
}

const INDEX_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function padKey(key: string): string {
  return key.padEnd(5, "0").slice(0, 12);
}

export function generatePosition(before?: string | null, after?: string | null): string {
  if (!before && !after) {
    return "a0000";
  }
  if (!before && after) {
    return padKey(midpoint(INDEX_ALPHABET[0], after[0] ?? "z") + after.slice(1));
  }
  if (before && !after) {
    const next = incrementKey(before);
    return padKey(next);
  }
  return padKey(midpoint(before as string, after as string));
}

function incrementKey(key: string): string {
  const chars = key.split("");
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const idx = INDEX_ALPHABET.indexOf(chars[i] ?? "0");
    if (idx < INDEX_ALPHABET.length - 1) {
      chars[i] = INDEX_ALPHABET[idx + 1] ?? "z";
      return chars.join("");
    }
    chars[i] = INDEX_ALPHABET[0] ?? "0";
  }
  return `${key}0`;
}

function midpoint(a: string, b: string): string {
  const max = Math.max(a.length, b.length, 5);
  const left = a.padEnd(max, INDEX_ALPHABET[0] ?? "0");
  const right = b.padEnd(max, INDEX_ALPHABET[INDEX_ALPHABET.length - 1] ?? "z");
  let result = "";
  for (let i = 0; i < max; i += 1) {
    const ai = INDEX_ALPHABET.indexOf(left[i] ?? "0");
    const bi = INDEX_ALPHABET.indexOf(right[i] ?? "z");
    const mid = Math.floor((Math.max(ai, 0) + Math.max(bi, 0)) / 2);
    result += INDEX_ALPHABET[mid] ?? "0";
  }
  if (result === a || result === b) {
    return `${a}V`;
  }
  return result;
}

export function textResult(data: unknown): { content: { type: "text"; text: string }[] } {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

export function errorResult(error: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

export function pageSummary(page: unknown): Json {
  if (!page || typeof page !== "object") {
    return { page };
  }
  const record = page as Json;
  return {
    id: record.id,
    slugId: record.slugId,
    title: record.title,
    icon: record.icon,
    spaceId: record.spaceId,
    parentPageId: record.parentPageId,
    position: record.position,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    creatorId: record.creatorId,
    lastUpdatedById: record.lastUpdatedById,
    hasChildren: record.hasChildren,
    permissions: record.permissions,
    space: record.space,
  };
}
