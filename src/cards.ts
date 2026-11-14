// Turning Allume MCP responses into plain card records.
//
// Allume documents its tool names but not the exact field names in their
// responses, so everything here reads defensively: several candidate keys,
// JSON or markdown-table payloads, text or binary content blocks.

import type { ToolResult } from "./mcp";

export type CardKind = "text" | "url" | "file" | "board" | "other";

export interface CardRef {
  /** The card's own id: its placement on the board. Used for card_move. */
  id: string;
  /** The id of the document behind the card (Allume's `document.id`). For a
   *  sub-board this is the board id that board_content wants. */
  docId?: string;
  kind: CardKind;
  rawType: string;
  title?: string;
  created?: string;
  raw: unknown;
}

export interface CardContent {
  text?: string;
  url?: string;
  title?: string;
  fileName?: string;
  mimeType?: string;
  blob?: Uint8Array;
  filePath?: string;
}

const ID_KEYS = ["id", "card_id", "cardId", "document_id", "documentId", "uuid", "doc_id"];
const TYPE_KEYS = ["type", "kind", "card_type", "cardType", "content_type", "contentType", "documentType"];
const TITLE_KEYS = ["title", "name", "label", "caption"];
const CREATED_KEYS = ["created_at", "createdAt", "created", "date_created", "dateCreated", "creationDate", "date"];
const TEXT_KEYS = ["body", "text", "content", "markdown", "plain_text", "plainText", "note", "string"];
const URL_KEYS = ["url", "link", "href", "source_url", "sourceURL", "sourceUrl", "web_url"];
const FILENAME_KEYS = ["filename", "fileName", "file_name", "original_filename", "originalFilename"];
const MIME_KEYS = ["mime_type", "mimeType", "mime", "content_type", "contentType", "uti"];
const PATH_KEYS = ["path", "file_path", "filePath", "file_uri", "fileUri", "fileURI", "uri", "file"];
const B64_KEYS = ["data", "blob", "base64", "payload", "bytes"];
const LIST_KEYS = ["cards", "items", "children", "results", "documents", "contents", "content", "entries"];

export function pick(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim() !== "") return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

export function classify(rawType: string): CardKind {
  const t = rawType.toLowerCase();
  if (!t) return "other";
  if (t.includes("board")) return "board";
  if (/(url|link|web|bookmark)/.test(t)) return "url";
  if (/(pdf|image|photo|picture|file|video|movie|audio|blob|attachment|ink|drawing)/.test(t)) return "file";
  if (/(note|text|chain|label|heading)/.test(t)) return "text";
  return "other";
}

/** Parse a markdown table (the CLI/MCP default format) into row objects. */
export function parseMarkdownTable(md: string): Record<string, string>[] {
  const lines = md
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));
  if (lines.length < 2) return [];
  const cells = (l: string) =>
    l
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  const header = cells(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  const rows: Record<string, string>[] = [];
  for (const l of lines.slice(1)) {
    if (/^\|?\s*:?-{2,}/.test(l)) continue; // separator row
    const c = cells(l);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = c[i] ?? ""));
    rows.push(row);
  }
  return rows;
}

/** Best-effort JSON parse of a tool result: structuredContent, else text blocks. */
export function resultPayload(result: ToolResult): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent;
  }
  const text = result.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function findList(payload: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(payload)) return payload as unknown[];
  if (!payload || typeof payload !== "object" || depth > 3) return null;
  const rec = payload as Record<string, unknown>;
  for (const k of LIST_KEYS) {
    if (Array.isArray(rec[k])) return rec[k] as unknown[];
  }
  for (const v of Object.values(rec)) {
    if (Array.isArray(v) && (v as unknown[]).some((x) => x && typeof x === "object")) return v as unknown[];
  }
  for (const v of Object.values(rec)) {
    const inner = findList(v, depth + 1);
    if (inner) return inner;
  }
  return null;
}

export function extractCards(payload: unknown): CardRef[] {
  let items: unknown[] = [];
  if (typeof payload === "string") {
    items = parseMarkdownTable(payload);
  } else {
    items = findList(payload) ?? [];
  }
  const cards: CardRef[] = [];
  for (const item of items) {
    const id = pick(item, ID_KEYS);
    if (!id) continue;
    const doc = (item as Record<string, unknown>)?.document;
    const docId = pick(doc, ID_KEYS);
    const rawType = [pick(item, TYPE_KEYS), pick(doc, TYPE_KEYS)].filter(Boolean).join("/");
    cards.push({
      id,
      docId,
      kind: classify(rawType),
      rawType,
      title: pick(item, TITLE_KEYS) ?? pick(doc, TITLE_KEYS),
      created: pick(item, CREATED_KEYS),
      raw: item,
    });
  }
  // Oldest first, so captures land in the order they were made.
  return cards.sort((a, b) => {
    const ta = a.created ? Date.parse(a.created) : NaN;
    const tb = b.created ? Date.parse(b.created) : NaN;
    if (isNaN(ta) || isNaN(tb)) return 0;
    return ta - tb;
  });
}

function decodeBase64(s: string): Uint8Array | undefined {
  const clean = s.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  if (clean.length < 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return undefined;
  try {
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

function toLocalPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  if (p.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(p).pathname);
    } catch {
      return undefined;
    }
  }
  return p.startsWith("/") ? p : undefined;
}

const URL_ONLY = /^https?:\/\/\S+$/i;

/**
 * Merge everything useful out of a card_content result. Only a file-mode
 * answer may name a local file: a summary carries the card's own text, and a
 * card whose text is "/Users/me/.ssh/id_ed25519" must not copy that file.
 */
export function contentFromResult(result: ToolResult, ref?: CardRef, fileMode = false): CardContent {
  const out: CardContent = {};
  const localPath = (p: string | undefined) => (fileMode ? toLocalPath(p) : undefined);

  for (const b of result.content) {
    if ((b.type === "image" || b.type === "audio") && b.data) {
      out.blob ??= decodeBase64(b.data);
      out.mimeType ??= b.mimeType;
    } else if (b.type === "resource" && b.resource) {
      if (b.resource.blob) {
        out.blob ??= decodeBase64(b.resource.blob);
        out.mimeType ??= b.resource.mimeType;
      } else if (b.resource.text && !out.text) {
        out.text = b.resource.text;
      }
      out.filePath ??= localPath(b.resource.uri);
    } else if (b.type === "resource_link") {
      out.filePath ??= localPath(b.uri);
      out.fileName ??= b.name;
      out.mimeType ??= b.mimeType;
    }
  }

  const payload = resultPayload(result);
  if (payload && typeof payload === "object") {
    const obj = (Array.isArray(payload) ? payload[0] : payload) as Record<string, unknown>;
    const nested = (obj?.card ?? obj?.document ?? obj) as Record<string, unknown>;
    out.text ??= pick(nested, TEXT_KEYS);
    // Kept as text unless it's a plain http(s) URL: it goes into the frontmatter.
    const url = pick(nested, URL_KEYS)?.trim();
    if (url && URL_ONLY.test(url)) out.url ??= url;
    else out.text ??= url;
    out.title ??= pick(nested, TITLE_KEYS);
    out.fileName ??= pick(nested, FILENAME_KEYS);
    out.mimeType ??= pick(nested, MIME_KEYS);
    out.filePath ??= localPath(pick(nested, PATH_KEYS));
    if (!out.blob) {
      const b64 = pick(nested, B64_KEYS);
      if (b64 && b64.length > 64) out.blob = decodeBase64(b64);
    }
  } else if (typeof payload === "string") {
    const s = payload.trim();
    const asPath = localPath(s);
    if (asPath && !s.includes("\n")) out.filePath ??= asPath;
    else if (URL_ONLY.test(s)) out.url ??= s;
    else out.text ??= s;
  }

  // A text card whose body is only a URL is really a link.
  if (!out.url && out.text && URL_ONLY.test(out.text.trim())) {
    out.url = out.text.trim();
    out.text = undefined;
  }
  out.title ??= ref?.title;
  return out;
}

export function hasPayload(c: CardContent): boolean {
  return Boolean((c.text && c.text.trim()) || c.url || c.blob || c.filePath);
}
