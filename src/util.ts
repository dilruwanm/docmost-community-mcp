import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DocmostError } from "./errors.js";

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

export type Heading = { level: number; text: string; offset: number };
export type SectionRange = { start: number; end: number };

function nodeText(node: unknown): string {
  const n = node as Json;
  if (typeof n?.text === "string") {
    return n.text;
  }
  return Array.isArray(n?.content) ? n.content.map(nodeText).join("") : "";
}

function topLevel(doc: Json): Json[] {
  return Array.isArray(doc.content) ? (doc.content as Json[]) : [];
}

function headingLevel(node: Json): number {
  return node.type === "heading" ? Number((node.attrs as Json | undefined)?.level ?? 1) : 0;
}

// shortcut: only top-level headings count as sections, not ones inside callouts or tables; upgrade if agents need them
// offset is the heading's character position in proseMirrorToMarkdown(doc), so get_page can page to it.
export function outline(doc: Json): Heading[] {
  const blocks = topLevel(doc);
  const found: Heading[] = [];
  blocks.forEach((node, i) => {
    if (headingLevel(node)) {
      const before = proseMirrorToMarkdown({ type: "doc", content: blocks.slice(0, i) });
      found.push({
        level: headingLevel(node),
        text: nodeText(node).trim(),
        offset: i === 0 ? 0 : before.length + 2,
      });
    }
  });
  return found;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

// "Text" matches any level; "## Text" pins the level. A section runs to the next heading of the same or higher level.
export function findSection(doc: Json, heading: string): SectionRange {
  const pin = /^(#{1,6})\s+(.*)$/.exec(heading.trim());
  const level = pin?.[1]?.length;
  const wanted = norm(pin?.[2] ?? heading);
  const blocks = topLevel(doc);
  const hits: number[] = [];
  blocks.forEach((node, i) => {
    const l = headingLevel(node);
    if (l && (!level || l === level) && norm(nodeText(node)) === wanted) {
      hits.push(i);
    }
  });
  if (hits.length === 0) {
    const names = blocks.filter(headingLevel).map((n) => `"${"#".repeat(headingLevel(n))} ${nodeText(n).trim()}"`);
    throw new DocmostError(`Heading not found: "${heading}". Headings on this page: ${names.slice(0, 30).join(", ") || "none"}`);
  }
  if (hits.length > 1) {
    const where = hits.map((i) => `level ${headingLevel(blocks[i] as Json)}`).join(", ");
    throw new DocmostError(`Heading "${heading}" matches ${hits.length} sections (${where}). Pin the level with "## ${heading}" or use replace_text.`);
  }
  const start = hits[0] as number;
  const startLevel = headingLevel(blocks[start] as Json);
  let end = start + 1;
  while (end < blocks.length) {
    const l = headingLevel(blocks[end] as Json);
    if (l && l <= startLevel) {
      break;
    }
    end += 1;
  }
  return { start, end };
}

// shortcut: a match must sit inside one block (paragraph, heading, list item); upgrade if agents need cross-paragraph replace.
// A match across formatted runs puts the new text in the first run, so it keeps that run's marks.
export function replaceTextInDoc(
  doc: Json,
  oldText: string,
  newText: string,
  all = false,
): { doc: Json; count: number } {
  if (!oldText) {
    throw new DocmostError("old_text must not be empty");
  }
  const next = structuredClone(doc);
  const blocks: Json[] = [];
  const walk = (node: Json) => {
    const kids = Array.isArray(node.content) ? (node.content as Json[]) : [];
    if (kids.some((k) => k.type === "text")) {
      blocks.push(node);
    } else {
      kids.forEach(walk);
    }
  };
  walk(next);

  // Non-text inline nodes (mentions, breaks) become U+FFFC so a match can never span them.
  const joined = (node: Json) =>
    (node.content as Json[]).map((k) => (k.type === "text" ? (k.text as string) : "￼")).join("");
  const hits = blocks.map((block) => {
    const text = joined(block);
    const at: number[] = [];
    for (let i = text.indexOf(oldText); i >= 0; i = text.indexOf(oldText, i + oldText.length)) {
      at.push(i);
    }
    return at;
  });
  const count = hits.reduce((n, at) => n + at.length, 0);
  if (count === 0) {
    throw new DocmostError(
      "old_text not found. It must match exactly and sit inside one paragraph, heading or list item.",
    );
  }
  if (count > 1 && !all) {
    const seen = blocks.flatMap((b, i) => (hits[i]?.length ? [`"${joined(b).slice(0, 60)}"`] : []));
    throw new DocmostError(
      `old_text matches ${count} places (in ${seen.slice(0, 3).join(", ")}). Add surrounding text to make it unique, or set replace_all.`,
    );
  }

  blocks.forEach((block, bi) => {
    for (const s of [...(hits[bi] ?? [])].reverse()) {
      const e = s + oldText.length;
      let pos = 0;
      let placed = false;
      const out: Json[] = [];
      for (const k of block.content as Json[]) {
        const len = k.type === "text" ? (k.text as string).length : 1;
        const a = pos;
        pos += len;
        if (k.type !== "text" || pos <= s || a >= e) {
          out.push(k);
          continue;
        }
        const t = k.text as string;
        const text = t.slice(0, Math.max(0, s - a)) + (placed ? "" : newText) + t.slice(Math.max(0, e - a));
        placed = true;
        if (text) {
          out.push({ ...k, text });
        }
      }
      block.content = out;
    }
  });
  return { doc: next, count };
}

const UNSUPPORTED: [string, RegExp][] = [
  ["table", /^\s*\|.*\|\s*$/],
  ["blockquote", /^\s*>/],
  ["callout", /^\s*:::/],
  ["task list", /^\s*[-*+]\s+\[[ xX]\]\s/],
  ["nested list", /^\s{2,}([-*+]|\d+[.)])\s/],
  ["horizontal rule", /^\s*([-*_])(\s*\1){2,}\s*$/],
  ["image", /!\[[^\]]*\]\(/],
];

// New content goes through the small local converter, so anything it cannot represent is refused, never mangled.
function markdownToBlocks(markdown: string): Json[] {
  let fenced = false;
  markdown.split(/\r?\n/).forEach((line, i) => {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
    } else if (!fenced) {
      const hit = UNSUPPORTED.find(([, re]) => re.test(line));
      if (hit) {
        throw new DocmostError(
          `Unsupported Markdown: ${hit[0]} (line ${i + 1}). Section edits support headings, paragraphs, one-level bullet and numbered lists, fenced code, and bold, italic, code and links. Use replace_text to change text inside existing rich content.`,
        );
      }
    }
  });
  const blocks = (markdownToProseMirror(markdown).content as Json[]).filter((b) => b.content);
  const stamp = (n: Json) => {
    if (n.type === "paragraph" || n.type === "heading") {
      n.attrs = { ...(n.attrs as Json | undefined), id: randomId() };
    }
    (Array.isArray(n.content) ? (n.content as Json[]) : []).forEach(stamp);
  };
  blocks.forEach(stamp);
  return blocks;
}

// Docmost blocks carry a 12-letter id; new blocks get a fresh one.
function randomId(): string {
  return Array.from({ length: 12 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
}

function editBlocks(
  doc: Json,
  heading: string,
  change: (r: SectionRange, blocks: Json[]) => [number, number, Json[]],
): Json {
  const next = structuredClone(doc);
  const [at, remove, add] = change(findSection(next, heading), topLevel(next));
  topLevel(next).splice(at, remove, ...add);
  return next;
}

// Keeps the heading, replaces everything under it (subsections included) until the next heading of the same or higher level.
export function replaceSection(doc: Json, heading: string, markdown: string): Json {
  return editBlocks(doc, heading, (r) => [r.start + 1, r.end - r.start - 1, markdownToBlocks(markdown)]);
}

export function insertAfterSection(doc: Json, heading: string, markdown: string): Json {
  if (!markdown.trim()) {
    throw new DocmostError("markdown must not be empty for insert_after_section");
  }
  return editBlocks(doc, heading, (r) => [r.end, 0, markdownToBlocks(markdown)]);
}

// at=start: right under the heading. at=end: the end of the section's own body, before its first subsection.
export function insertInSection(doc: Json, heading: string, markdown: string, at = "end"): Json {
  if (at !== "start" && at !== "end") {
    throw new DocmostError('at must be "start" or "end"');
  }
  if (!markdown.trim()) {
    throw new DocmostError("markdown must not be empty for insert_in_section");
  }
  return editBlocks(doc, heading, (r, blocks) => {
    const firstSub = blocks.findIndex((b, i) => i > r.start && i < r.end && headingLevel(b) > 0);
    const where = at === "start" ? r.start + 1 : firstSub === -1 ? r.end : firstSub;
    return [where, 0, markdownToBlocks(markdown)];
  });
}

export function deleteSection(doc: Json, heading: string): Json {
  return editBlocks(doc, heading, (r) => [r.start, r.end - r.start, []]);
}

export type PageEdit = {
  mode: "replace_text" | "replace_section" | "insert_after_section" | "insert_in_section" | "delete_section";
  old_text?: string;
  new_text?: string;
  replace_all?: boolean;
  heading?: string;
  markdown?: string;
  at?: "start" | "end";
};

// Applies edits in order, in memory. Any failure throws and names the edit, so the caller writes nothing.
export function applyEdits(doc: Json, edits: PageEdit[]): { doc: Json; applied: Json[] } {
  let current = doc;
  const applied: Json[] = [];
  edits.forEach((edit, i) => {
    const need = <T>(value: T | undefined, name: string): T => {
      if (value === undefined) {
        throw new DocmostError(`${name} is required for ${edit.mode}`);
      }
      return value;
    };
    try {
      if (edit.mode === "replace_text") {
        const r = replaceTextInDoc(current, need(edit.old_text, "old_text"), need(edit.new_text, "new_text"), edit.replace_all);
        current = r.doc;
        applied.push({ mode: edit.mode, replaced: r.count });
        return;
      }
      const heading = need(edit.heading, "heading");
      if (edit.mode === "replace_section") {
        current = replaceSection(current, heading, need(edit.markdown, "markdown"));
      } else if (edit.mode === "insert_after_section") {
        current = insertAfterSection(current, heading, need(edit.markdown, "markdown"));
      } else if (edit.mode === "insert_in_section") {
        current = insertInSection(current, heading, need(edit.markdown, "markdown"), edit.at);
      } else {
        current = deleteSection(current, heading);
      }
      applied.push({ mode: edit.mode, heading });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DocmostError(`Edit #${i + 1} (${edit.mode}) failed, nothing was written: ${message}`);
    }
  });
  return { doc: current, applied };
}

// Longest page body returned in one call; past this the caller follows next_offset.
export const MAX_CONTENT_CHARS = 40_000;

// truncated and next_offset are present only while more text remains, so following them reassembles the original exactly.
export function sliceContent(text: string, offset = 0, max = MAX_CONTENT_CHARS): Json {
  const end = offset + max;
  return {
    content: text.slice(offset, end),
    total_chars: text.length,
    ...(end < text.length ? { truncated: true, next_offset: end } : {}),
  };
}

export function sectionToMarkdown(doc: Json, range: SectionRange): string {
  return proseMirrorToMarkdown({ type: "doc", content: topLevel(doc).slice(range.start, range.end) });
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
  // Compact, and null object fields are omitted (absent means null); array slots keep their position.
  const text = typeof data === "string" ? data : JSON.stringify(data, (_k, v) => (v === null ? undefined : v));
  return { content: [{ type: "text", text }] };
}

export function errorResult(error: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

const asRecord = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});

export const pick = (v: unknown, keys: string[]): Json =>
  Object.fromEntries(keys.map((k) => [k, asRecord(v)[k]]));

export const omit = (v: unknown, keys: string[]): Json =>
  Object.fromEntries(Object.entries(asRecord(v)).filter(([k]) => !keys.includes(k)));

// Default list item; verbose=true returns pageSummary instead.
export function slimPage(page: unknown): Json {
  return pick(page, ["id", "slugId", "title", "icon", "parentPageId", "hasChildren", "updatedAt"]);
}

// Default result of a write; verbose=true returns pageSummary instead.
export function pageAck(page: unknown): Json {
  return pick(page, ["id", "slugId", "title", "updatedAt"]);
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
