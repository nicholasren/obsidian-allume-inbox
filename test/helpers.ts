import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalFile } from "../src/files";
import type { Ledger, SyncOptions, VaultIO } from "../src/sync";

export const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fake-allume.mjs");

export function tempVault(): { root: string; io: VaultIO; file: (p: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const abs = (p: string) => join(root, p);
  const io: VaultIO = {
    async exists(p) {
      return existsSync(abs(p));
    },
    async read(p) {
      return existsSync(abs(p)) ? readFileSync(abs(p), "utf8") : null;
    },
    async process(p, fn) {
      const old = existsSync(abs(p)) ? readFileSync(abs(p), "utf8") : "";
      writeFileSync(abs(p), fn(old));
    },
    async create(p, text) {
      if (existsSync(abs(p))) throw new Error(`exists: ${p}`);
      writeFileSync(abs(p), text);
    },
    async createBinary(p, data) {
      writeFileSync(abs(p), data);
    },
    readExternal: (a) => readLocalFile(a),
    async attachmentPath(name) {
      let p = `assets/${name}`;
      for (let n = 1; existsSync(abs(p)); n++) p = `assets/${name.replace(/(\.\w+)$/, ` ${n}$1`)}`;
      return p;
    },
    async ensureFolder(p) {
      mkdirSync(abs(p), { recursive: true });
    },
  };
  return { root, io, file: (p) => readFileSync(abs(p), "utf8") };
}

export function memLedger(): Ledger & { ids: Set<string> } {
  const ids = new Set<string>();
  return { ids, has: (id) => ids.has(id), add: (id) => void ids.add(id) };
}

export function opts(over: Partial<SyncOptions> = {}): SyncOptions {
  return {
    boardId: "inbox",
    mode: "daily",
    dailyNotePath: "Journals/2026-11-14.md",
    heading: "## Captured",
    noteFolder: "Inbox",
    marker: true,
    afterSync: "keep",
    syncedBoardId: "",
    today: "2026-11-14",
    stamp: (d) => {
      const iso = d.toISOString().slice(0, 16);
      return { iso, fileStamp: iso.replace("T", " ").replace(":", "") };
    },
    now: new Date("2026-11-14T01:00:00Z"),
    ...over,
  };
}
