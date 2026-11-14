// Pure text helpers: how a capture looks in the vault, and where it goes.

import type { CardContent } from "./cards";

export const MARKER = (id: string) => `%%allume:${id}%%`;

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/webp": "webp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "text/plain": "txt",
  "text/markdown": "md",
  "public.jpeg": "jpg",
  "public.png": "png",
  "public.heic": "heic",
  "com.adobe.pdf": "pdf",
};

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "heic", "heif", "webp", "tiff", "svg", "bmp", "avif"]);

export function extFromMime(mime?: string): string | undefined {
  if (!mime) return undefined;
  return MIME_EXT[mime.toLowerCase().split(";")[0].trim()];
}

/** Sniff a few common formats from the first bytes. */
export function extFromBytes(b?: Uint8Array): string | undefined {
  if (!b || b.length < 12) return undefined;
  const hex = (n: number) => [...b.slice(0, n)].map((x) => x.toString(16).padStart(2, "0")).join("");
  if (hex(3) === "ffd8ff") return "jpg";
  if (hex(8) === "89504e470d0a1a0a") return "png";
  if (hex(4) === "25504446") return "pdf";
  if (hex(4) === "47494638") return "gif";
  const ascii = String.fromCharCode(...b.slice(4, 12));
  if (ascii.startsWith("ftypheic") || ascii.startsWith("ftypheix") || ascii.startsWith("ftypmif1")) return "heic";
  if (ascii.startsWith("ftypqt")) return "mov";
  if (ascii.startsWith("ftyp")) return "mp4";
  if (String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "webp";
  return undefined;
}

export function sanitizeFileName(name: string, max = 80): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .split("")
    .map((ch) => (ch.charCodeAt(0) < 32 ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max).trim();
}

export function splitExt(name: string): [string, string | undefined] {
  const m = name.match(/^(.*)\.([A-Za-z0-9]{1,5})$/);
  return m ? [m[1], m[2].toLowerCase()] : [name, undefined];
}

/** Attachment file name: allume-<date>-<short id>-<original>.<ext> */
export function attachmentName(c: CardContent, cardId: string, date: string): string {
  // Prefer the user's own name for the file; a staged path is often a UUID.
  const fromPath = c.filePath ? c.filePath.split("/").pop() : undefined;
  const original = c.fileName || c.title || fromPath || "";
  const [base, ext0] = splitExt(sanitizeFileName(original, 60));
  const ext =
    ext0 ||
    (fromPath ? splitExt(fromPath)[1] : undefined) ||
    extFromMime(c.mimeType) ||
    extFromBytes(c.blob) ||
    "bin";
  const shortId = sanitizeFileName(cardId, 40).replace(/\s+/g, "").slice(0, 8);
  const parts = ["allume", date, shortId, base].filter(Boolean);
  return `${parts.join("-").replace(/\s+/g, "-")}.${ext}`;
}

export function isImage(fileName: string): boolean {
  return IMAGE_EXT.has(splitExt(fileName)[1] ?? "");
}

function linkTo(fileName: string): string {
  return isImage(fileName) ? `![[${fileName}]]` : `[[${fileName}]]`;
}

function escapeLinkText(s: string): string {
  return s.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
}

export interface RenderInput {
  id: string;
  content: CardContent;
  attachment?: string; // vault file name of the saved attachment
  marker: boolean;
}

const ZWSP = "\u200B";

/**
 * Captured text comes from anyone who can post to the inbox, including
 * collaborators in a shared workspace. Break the syntax that Templater (on file
 * creation) and Dataview JS run as code, so a capture is only ever shown.
 */
export function inert(line: string): string {
  return line
    .replace(/<%/g, `<${ZWSP}%`)
    .replace(/^(\s*(?:```|~~~)\s*)dataviewjs\b/i, "$1js")
    .replace(/`\$=/g, `\`${ZWSP}$=`);
}

/** Lines in the body of a capture, without the bullet. */
function bodyLines({ content, attachment }: RenderInput): string[] {
  const out: string[] = [];
  const text = content.text?.replace(/\r\n/g, "\n").trim();
  const title = content.title?.trim();
  if (attachment) {
    out.push(linkTo(attachment));
    const caption = text || (title && !attachment.includes(sanitizeFileName(title).replace(/\s+/g, "-")) ? title : "");
    if (caption) out.push(...caption.split("\n"));
    if (content.url) out.push(content.url);
  } else if (content.url) {
    const label = title && title !== content.url ? escapeLinkText(title) : "";
    out.push(label ? `[${label}](${content.url})` : content.url);
    if (text && text !== content.url && text !== title) out.push(...text.split("\n"));
  } else if (text) {
    if (title && !text.startsWith(title)) out.push(title);
    out.push(...text.split("\n"));
  } else if (title) {
    out.push(title);
  }
  return out.map(inert);
}

/** A capture as one list item, continuation lines indented under it. */
export function renderListItem(input: RenderInput): string {
  const lines = bodyLines(input);
  if (lines.length === 0) {
    lines.push("(Allume card with nothing exportable — open it in Allume)");
  }
  const [first, ...rest] = lines;
  const head = `- ${first}${input.marker ? ` ${MARKER(input.id)}` : ""}`;
  return [head, ...rest.map((l) => (l.trim() ? `  ${l}` : ""))].join("\n").replace(/\n+$/, "");
}

/** A capture as its own note, with frontmatter. */
export function renderNote(input: RenderInput, captured: string): string {
  const fm = ["---", "source: allume", `allume_id: "${input.id}"`, `captured: ${captured}`];
  if (input.content.url) fm.push(`url: "${input.content.url.replace(/"/g, "%22")}"`);
  fm.push("---", "");
  const body = bodyLines(input);
  return fm.join("\n") + (body.length ? body.join("\n") : "(Allume card with nothing exportable — open it in Allume)") + "\n";
}

/** File name stem for note-per-capture mode. */
export function noteTitle(input: RenderInput, stamp: string): string {
  const c = input.content;
  const seed =
    c.title ||
    c.text?.split("\n").find((l) => l.trim()) ||
    (c.url ? c.url.replace(/^https?:\/\//, "") : "") ||
    input.attachment ||
    "Allume capture";
  const stem = sanitizeFileName(seed, 60) || "Allume capture";
  return `${stamp} ${stem}`;
}

/**
 * Insert a block at the end of the section under `heading`.
 * If the heading is missing, append it at the end of the note.
 * Headings inside fenced code blocks are ignored.
 */
export function insertUnderHeading(content: string, heading: string, block: string): string {
  const level = (heading.match(/^#+/)?.[0].length ?? 2);
  const lines = content.split("\n");
  let inFence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    if (start < 0) {
      if (line.trimEnd() === heading.trim()) start = i;
    } else {
      const m = line.match(/^(#{1,6})\s/);
      if (m && m[1].length <= level) {
        end = i;
        break;
      }
    }
  }

  if (start < 0) {
    const base = content.replace(/\s+$/, "");
    return (base ? `${base}\n\n` : "") + `${heading}\n${block}\n`;
  }

  let insertAt = end;
  while (insertAt - 1 > start && lines[insertAt - 1].trim() === "") insertAt--;
  const before = lines.slice(0, insertAt);
  const after = lines.slice(end);
  const out = [...before, ...block.split("\n")];
  if (after.length) out.push("", ...after);
  else out.push("");
  return out.join("\n");
}
