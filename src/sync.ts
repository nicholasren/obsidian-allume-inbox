// The sync engine. Knows nothing about Obsidian: it talks to an AllumeSource
// and a VaultIO, both of which are faked in tests.

import type { AllumeSource } from "./allume";
import { hasPayload, type CardContent, type CardRef } from "./cards";
import {
  MARKER,
  attachmentName,
  insertUnderHeading,
  noteTitle,
  renderListItem,
  renderNote,
  type RenderInput,
} from "./format";

export type LandingMode = "daily" | "note";
export type AfterSync = "keep" | "delete" | "move";

export interface SyncOptions {
  boardId: string;
  mode: LandingMode;
  /** Vault path of the daily note to append to (mode "daily"). */
  dailyNotePath: string;
  heading: string;
  /** Folder for note-per-capture mode. */
  noteFolder: string;
  marker: boolean;
  afterSync: AfterSync;
  syncedBoardId: string;
  /** Local date for attachment names, YYYY-MM-DD. */
  today: string;
  /** Formats a capture time for note names and frontmatter. */
  stamp: (d: Date) => { fileStamp: string; iso: string };
  now: Date;
  dryRun?: boolean;
}

export interface VaultIO {
  exists(path: string): Promise<boolean>;
  /** Create the file if missing, then replace its text with fn(old). */
  process(path: string, fn: (old: string) => string): Promise<void>;
  create(path: string, text: string): Promise<void>;
  createBinary(path: string, data: Uint8Array): Promise<void>;
  readExternal(absPath: string): Promise<Uint8Array>;
  /** Next free vault path for an attachment, honouring the user's settings. */
  attachmentPath(fileName: string, sourcePath: string): Promise<string>;
  ensureFolder(path: string): Promise<void>;
  read(path: string): Promise<string | null>;
}

export interface Ledger {
  has(id: string): boolean;
  add(id: string): void;
}

export interface SyncReport {
  seen: number;
  added: string[];
  skipped: number;
  /** Cards removed from or moved out of the source in Allume. */
  moved: number;
  warnings: string[];
  errors: string[];
  preview: string[];
}

function parent(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "";
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

async function uniquePath(io: VaultIO, folder: string, stem: string, ext: string): Promise<string> {
  const prefix = folder ? `${folder}/` : "";
  let path = `${prefix}${stem}.${ext}`;
  for (let n = 2; await io.exists(path); n++) path = `${prefix}${stem} ${n}.${ext}`;
  return path;
}

async function gatherContent(api: AllumeSource, ref: CardRef): Promise<CardContent> {
  const summary: CardContent = ref.kind === "file" ? {} : await api.cardContent(ref);
  if (ref.kind !== "file" && hasPayload(summary)) return summary;
  // Files, and cards whose summary had nothing usable: ask for the payload.
  const file = await api.cardFile(ref);
  let merged: CardContent = { ...stripEmpty(summary), ...stripEmpty(file) };
  if (ref.kind === "file") {
    // The summary may carry a title or file name. Its text can be OCR output,
    // so it is not used as a caption.
    const extra = await api.cardContent(ref).catch(() => ({}) as CardContent);
    merged = {
      ...stripEmpty({ title: extra.title, fileName: extra.fileName, mimeType: extra.mimeType }),
      ...merged,
    };
    if (merged.blob || merged.filePath) merged.text = file.text;
  }
  merged.title ??= ref.title;
  return merged;
}

function stripEmpty(c: CardContent): CardContent {
  const out: CardContent = {};
  for (const [k, v] of Object.entries(c)) {
    if (v !== undefined && v !== "") (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export async function runSync(
  api: AllumeSource,
  io: VaultIO,
  ledger: Ledger,
  opts: SyncOptions,
): Promise<SyncReport> {
  const report: SyncReport = { seen: 0, added: [], skipped: 0, moved: 0, warnings: [], errors: [], preview: [] };
  if (!opts.boardId) throw new Error("No Allume inbox board is set.");

  const cards = await api.boardCards(opts.boardId);
  report.seen = cards.length;

  const action = opts.afterSync;
  const wantsCleanup = action === "delete" || (action === "move" && Boolean(opts.syncedBoardId));
  if (action === "move" && opts.syncedBoardId === opts.boardId) {
    throw new Error("The inbox board and the “move to” board are the same.");
  }
  const canClean = wantsCleanup && api.canCleanUp(action);
  if (wantsCleanup && !canClean) {
    report.warnings.push(
      action === "move"
        ? "Allume can only move cards out of its built-in Inbox, and needs MCP in read-write mode. Cards stay where they are."
        : "Allume's MCP is read-only, so cards stay in Allume. Switch it to read-write to remove them.",
    );
  }
  const cleanUp = async (ref: CardRef) => {
    try {
      await api.cleanUp(ref, action as "delete" | "move", opts.syncedBoardId);
      report.moved++;
    } catch (e) {
      report.warnings.push(`Saved, but couldn't ${action === "move" ? "move" : "remove"} card ${ref.id} in Allume: ${(e as Error).message}`);
    }
  };

  for (const ref of cards) {
    if (ref.kind === "board") {
      report.skipped++;
      continue;
    }
    if (ledger.has(ref.id)) {
      // Already in the vault: clean it up in Allume too (an earlier sync may
      // have run with "keep", or its clean-up failed).
      if (canClean && !opts.dryRun) await cleanUp(ref);
      report.skipped++;
      continue;
    }

    try {
      const content = await gatherContent(api, ref);
      const created = ref.created && !isNaN(Date.parse(ref.created)) ? new Date(ref.created) : opts.now;
      const { fileStamp, iso } = opts.stamp(created);

      const notePath =
        opts.mode === "daily"
          ? opts.dailyNotePath
          : await uniquePath(
              io,
              opts.noteFolder,
              noteTitle({ id: ref.id, content, marker: false }, fileStamp),
              "md",
            );

      // Attachment first, so the note never links to a missing file.
      let attachment: string | undefined;
      if (content.blob || content.filePath) {
        const name = attachmentName(content, ref.id, opts.today);
        if (!opts.dryRun) {
          const bytes = content.blob ?? (await io.readExternal(content.filePath as string));
          const dest = await io.attachmentPath(name, notePath);
          if (parent(dest)) await io.ensureFolder(parent(dest));
          await io.createBinary(dest, bytes);
          attachment = baseName(dest);
        } else {
          attachment = name;
        }
      }

      const input: RenderInput = { id: ref.id, content, attachment, marker: opts.marker };

      if (opts.mode === "daily") {
        const item = renderListItem(input);
        if (opts.dryRun) {
          report.preview.push(item);
        } else {
          const existing = await io.read(notePath);
          if (existing && existing.includes(MARKER(ref.id))) {
            // Written on an earlier run whose ledger update was lost.
          } else {
            if (parent(notePath)) await io.ensureFolder(parent(notePath));
            await io.process(notePath, (old) => insertUnderHeading(old, opts.heading, item));
          }
        }
      } else {
        const text = renderNote(input, iso);
        if (opts.dryRun) {
          report.preview.push(`${notePath}\n${text}`);
        } else {
          if (opts.noteFolder) await io.ensureFolder(opts.noteFolder);
          await io.create(notePath, text);
        }
      }

      if (opts.dryRun) continue;
      ledger.add(ref.id);
      report.added.push(ref.id);

      if (canClean) await cleanUp(ref);
    } catch (e) {
      report.errors.push(`Card ${ref.id}: ${(e as Error).message}`);
    }
  }
  return report;
}
