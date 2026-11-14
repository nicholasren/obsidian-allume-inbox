import { Notice, Plugin, moment, normalizePath, setIcon, type TFile } from "obsidian";
import { execFile } from "child_process";
import { existsSync, promises as fsp } from "fs";
import { AllumeError, AllumeMcp, friendlyError } from "./allume";
import { resultPayload } from "./cards";
import { DEFAULT_SETTINGS, HELPER_CANDIDATES, LEDGER_CAP, type AllumeInboxSettings } from "./settings";
import { runSync, type Ledger, type SyncOptions, type SyncReport, type VaultIO } from "./sync";
import { AllumeInboxSettingTab, BoardPickerModal, TextModal } from "./ui";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default class AllumeInboxPlugin extends Plugin {
  settings!: AllumeInboxSettings;
  private syncing = false;
  private timer: number | null = null;
  private statusEl!: HTMLElement;
  private quietError = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    this.statusEl.onClickEvent(() => void this.sync(true));
    this.setStatus(this.settings.lastSync ? `Allume ${this.settings.lastSync}` : "Allume");

    this.addRibbonIcon("inbox", "Sync Allume inbox", () => void this.sync(true));

    this.addCommand({ id: "sync", name: "Sync now", callback: () => void this.sync(true) });
    this.addCommand({ id: "preview", name: "Preview next sync", callback: () => void this.preview() });
    this.addCommand({
      id: "choose-board",
      name: "Choose inbox board",
      callback: () =>
        new BoardPickerModal(this.app, this, async (hit) => {
          this.settings.inboxBoardId = hit.id;
          this.settings.inboxBoardName = hit.title;
          await this.saveSettings();
          new Notice(`Allume inbox: ${hit.title}`);
        }).open(),
    });
    this.addCommand({ id: "debug-dump", name: "Show raw Allume responses", callback: () => void this.debugDump() });

    this.addSettingTab(new AllumeInboxSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.schedule();
      if (this.settings.syncOnStartup && this.settings.inboxBoardId) {
        window.setTimeout(() => void this.sync(false), 3000);
      }
    });
  }

  onunload(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
  }

  // ------------------------------------------------------------ settings

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!existsSync(this.settings.helperPath)) {
      const found = this.detectHelper();
      if (found) this.settings.helperPath = found;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  schedule(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    const mins = this.settings.intervalMinutes;
    if (mins > 0) {
      this.timer = window.setInterval(() => void this.sync(false), mins * 60_000);
      this.registerInterval(this.timer);
    }
  }

  detectHelper(): string | null {
    return HELPER_CANDIDATES.find((p) => existsSync(p)) ?? null;
  }

  dailyNoteConfig(): { folder: string; format: string } {
    // The core Daily notes plugin keeps its options on its instance.
    const internal = (this.app as unknown as { internalPlugins?: { getPluginById?: (id: string) => any } }).internalPlugins;
    const dn = internal?.getPluginById?.("daily-notes");
    const o = dn?.enabled ? dn.instance?.options : undefined;
    return {
      folder: (o?.folder ?? "").replace(/^\/+|\/+$/g, ""),
      format: o?.format || "YYYY-MM-DD",
    };
  }

  private dailyNotePath(now: Date): string {
    const d = this.dailyNoteConfig();
    const folder = this.settings.dailyFolder || d.folder;
    const format = this.settings.dailyFormat || d.format;
    return normalizePath(`${folder ? folder + "/" : ""}${moment(now).format(format)}.md`);
  }

  // ------------------------------------------------------------ allume

  async connect(): Promise<AllumeMcp> {
    const logger = this.settings.debugLog ? (line: string) => this.log(line) : null;
    return AllumeMcp.connect(this.settings.helperPath, 30_000, this.manifest.version, logger);
  }

  private logLines: string[] = [];

  log(line: string): void {
    if (!this.settings.debugLog) return;
    this.logLines.push(`${moment().format("YYYY-MM-DD HH:mm:ss")} ${line}`);
  }

  /** Write buffered log lines to <plugin folder>/debug.log, keeping it under ~1 MB. */
  private async flushLog(): Promise<void> {
    if (!this.logLines.length || !this.manifest.dir) return;
    const path = normalizePath(`${this.manifest.dir}/debug.log`);
    const text = this.logLines.join("\n") + "\n";
    this.logLines = [];
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(path)) {
        const old = await adapter.read(path);
        const merged = old + text;
        await adapter.write(path, merged.length > 1_000_000 ? merged.slice(-500_000) : merged);
      } else {
        await adapter.write(path, text);
      }
    } catch (e) {
      console.warn("[allume-inbox] couldn't write debug.log", e);
    }
  }

  /**
   * Make sure the board ids are known. A name typed in settings (such as
   * "Inbox") is looked up once and its id remembered.
   */
  private async ensureBoards(api: AllumeMcp, force = false): Promise<void> {
    const s = this.settings;
    let changed = false;
    if (s.source === "board" && (force || !s.inboxBoardId) && s.inboxBoardName) {
      const r = await api.resolveBoard(s.inboxBoardName);
      this.log(`resolved inbox “${s.inboxBoardName}” -> ${r.id}`);
      s.inboxBoardId = r.id;
      changed = true;
    }
    if (s.afterSync === "move" && (force || !s.syncedBoardId) && s.syncedBoardName) {
      const r = await api.resolveBoard(s.syncedBoardName);
      this.log(`resolved synced board “${s.syncedBoardName}” -> ${r.id}`);
      s.syncedBoardId = r.id;
      changed = true;
    }
    if (changed) await this.saveSettings();
  }

  private hasInbox(): boolean {
    const s = this.settings;
    return s.source === "inbox" || Boolean(s.inboxBoardId || s.inboxBoardName);
  }

  /** The boards to read: every workspace's built-in Inbox, or one named board. */
  private async sourceBoards(api: AllumeMcp, forceResolve = false): Promise<{ id: string; title: string }[]> {
    const s = this.settings;
    if (s.source === "inbox") {
      const boards = await api.inboxBoards(s.workspace);
      if (!boards.length) {
        throw new AllumeError(
          s.workspace ? `No Allume workspace named “${s.workspace}”.` : "Allume didn't list any workspace inboxes.",
          s.workspace ? "Check the workspace name in Allume Inbox settings, or leave it blank for all." : "Update Allume to v4 or later.",
        );
      }
      return boards;
    }
    await this.ensureBoards(api, forceResolve);
    return [{ id: s.inboxBoardId, title: s.inboxBoardName || s.inboxBoardId }];
  }

  /** runSync over every source board, re-resolving a board name once if its id has gone stale. */
  private async syncWith(api: AllumeMcp, dryRun = false): Promise<SyncReport> {
    const s = this.settings;
    if (s.afterSync === "move" && !s.syncedBoardId && s.syncedBoardName) await this.ensureBoards(api);
    const ledger = this.ledger();
    const total: SyncReport = { seen: 0, added: [], skipped: 0, moved: 0, warnings: [], errors: [], preview: [] };
    let boards = await this.sourceBoards(api);
    let ok = 0;
    let lastErr: unknown = null;
    const runOne = async (b: { id: string; title: string }) => {
      const r = await runSync(api, this.vaultIO(), ledger, { ...this.syncOptions(dryRun), boardId: b.id });
      total.seen += r.seen;
      total.added.push(...r.added);
      total.skipped += r.skipped;
      total.moved += r.moved;
      total.warnings.push(...r.warnings.filter((w) => !total.warnings.includes(w)));
      total.errors.push(...r.errors);
      total.preview.push(...r.preview);
      ok++;
    };
    for (const b of boards) {
      try {
        await runOne(b);
      } catch (e) {
        const err = friendlyError(e);
        this.log(`couldn't read ${b.title} (${b.id}): ${err.message}`);
        lastErr = err;
      }
    }
    // A named board whose stored id went stale: look the name up again, once.
    if (!ok && s.source === "board" && s.inboxBoardName) {
      const stale = boards[0]?.id;
      boards = await this.sourceBoards(api, true);
      if (boards[0] && boards[0].id !== stale) {
        try {
          await runOne(boards[0]);
          lastErr = null;
        } catch (e) {
          lastErr = friendlyError(e);
        }
      }
    }
    if (!ok && lastErr && s.source === "inbox") {
      throw new AllumeError(
        "Couldn't read Allume's built-in Inbox over MCP.",
        `Allume said: ${(lastErr as Error).message}. Workaround: set Source to “A board”.`,
      );
    }
    if (!ok && lastErr) throw lastErr;
    return total;
  }

  private launchAllume(): Promise<void> {
    return new Promise((resolve) => {
      execFile("/usr/bin/open", ["-g", "-a", "Allume"], () => resolve());
    });
  }

  /** Run fn against Allume, launching the app once if it isn't running. */
  private async withAllume<T>(fn: (api: AllumeMcp) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let api: AllumeMcp | null = null;
      try {
        api = await this.connect();
        return await fn(api);
      } catch (e) {
        const err = friendlyError(e);
        this.log(`error: ${err.message}`);
        const notRunning = /isn't running|exited|not running/i.test(err.message);
        if (attempt === 0 && notRunning && this.settings.launchAllume) {
          await this.launchAllume();
          await sleep(8000);
          continue;
        }
        throw err;
      } finally {
        api?.close();
        await this.flushLog();
      }
    }
  }

  async testConnection(): Promise<void> {
    try {
      const msg = await this.withAllume(async (api) => {
        const info = api.serverInfo as { name?: string; version?: string } | null;
        const mode = api.canMove() ? "read-write" : "read-only";
        let board = "";
        if (this.hasInbox()) {
          const parts: string[] = [];
          for (const b of await this.sourceBoards(api)) {
            try {
              parts.push(`${b.title}: ${(await api.boardCards(b.id)).length} cards`);
            } catch (e) {
              parts.push(`${b.title}: ${friendlyError(e).message}`);
            }
          }
          board = `\n${parts.join("\n")}`;
        }
        return `Connected to ${info?.name ?? "Allume"} ${info?.version ?? ""}: ${api.toolNames().length} tools, ${mode}${board}.`;
      });
      new Notice(msg, 8000);
    } catch (e) {
      this.notifyError(e as AllumeError, 0);
    }
  }

  // ------------------------------------------------------------ vault io

  private vaultIO(): VaultIO {
    const vault = this.app.vault;
    const ensureFolder = async (path: string) => {
      const parts = normalizePath(path).split("/").filter(Boolean);
      let cur = "";
      for (const p of parts) {
        cur = cur ? `${cur}/${p}` : p;
        if (!vault.getFolderByPath(cur)) {
          try {
            await vault.createFolder(cur);
          } catch {
            /* created concurrently */
          }
        }
      }
    };
    return {
      exists: async (p) => vault.adapter.exists(normalizePath(p)),
      read: async (p) => {
        const f = vault.getFileByPath(normalizePath(p));
        return f ? vault.read(f) : null;
      },
      process: async (p, fn) => {
        const path = normalizePath(p);
        const f: TFile | null = vault.getFileByPath(path);
        if (f) await vault.process(f, fn);
        else await vault.create(path, fn(""));
      },
      create: async (p, text) => {
        await vault.create(normalizePath(p), text);
      },
      createBinary: async (p, data) => {
        const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        await vault.createBinary(normalizePath(p), buf);
      },
      readExternal: async (abs) => new Uint8Array(await fsp.readFile(abs)),
      attachmentPath: (name, source) => this.app.fileManager.getAvailablePathForAttachment(name, source),
      ensureFolder,
    };
  }

  private ledger(): Ledger {
    const ids = new Set(this.settings.syncedIds);
    return {
      has: (id) => ids.has(id),
      add: (id) => {
        ids.add(id);
        this.settings.syncedIds.push(id);
        if (this.settings.syncedIds.length > LEDGER_CAP) {
          this.settings.syncedIds.splice(0, this.settings.syncedIds.length - LEDGER_CAP);
        }
      },
    };
  }

  private syncOptions(dryRun = false): SyncOptions {
    const now = new Date();
    const s = this.settings;
    return {
      boardId: s.inboxBoardId,
      mode: s.mode,
      dailyNotePath: this.dailyNotePath(now),
      heading: s.heading,
      noteFolder: normalizePath(s.noteFolder || "Inbox"),
      marker: s.marker,
      afterSync: s.afterSync,
      syncedBoardId: s.syncedBoardId,
      today: moment(now).format("YYYY-MM-DD"),
      stamp: (d) => ({ fileStamp: moment(d).format("YYYY-MM-DD HHmm"), iso: moment(d).format("YYYY-MM-DDTHH:mm") }),
      now,
      dryRun,
    };
  }

  // ------------------------------------------------------------ sync

  async sync(manual: boolean): Promise<SyncReport | null> {
    if (this.syncing) {
      if (manual) new Notice("Allume sync is already running.");
      return null;
    }
    if (!this.hasInbox()) {
      if (manual) new Notice("Set an Allume inbox board in the Allume Inbox settings first.");
      return null;
    }
    this.syncing = true;
    this.setStatus("Allume …", "Syncing");
    try {
      const report = await this.withAllume((api) => this.syncWith(api));
      this.settings.lastSync = moment().format("HH:mm");
      await this.saveSettings();
      this.quietError = false;

      const n = report.added.length;
      const problems = [...report.errors, ...report.warnings];
      this.setStatus(
        `Allume ${this.settings.lastSync}${report.errors.length ? " !" : ""}`,
        problems.length ? problems.join("\n") : `Last sync ${this.settings.lastSync}. Click to sync now.`,
      );
      const cleaned = report.moved
        ? `, ${report.moved} ${this.settings.afterSync === "move" ? "moved out of" : "removed from"} Allume`
        : "";
      if ((n || report.moved) && (this.settings.notifyNew || manual)) {
        new Notice(`Allume: ${n} new capture${n === 1 ? "" : "s"}${cleaned}`);
      } else if (manual && !problems.length) new Notice("Allume: nothing new");
      if (problems.length && (manual || report.errors.length)) {
        new Notice(`Allume: ${problems.slice(0, 3).join("\n")}`, 10_000);
      }
      if (report.errors.length) console.warn("[allume-inbox]", report.errors);
      return report;
    } catch (e) {
      const err = friendlyError(e);
      this.setStatus("Allume !", `${err.message}${err.hint ? `\n${err.hint}` : ""}`);
      // Background failures notify once until the next success.
      if (manual || !this.quietError) this.notifyError(err, manual ? 10_000 : 6000);
      this.quietError = true;
      return null;
    } finally {
      this.syncing = false;
    }
  }

  private async preview(): Promise<void> {
    if (!this.hasInbox()) {
      new Notice("Set an Allume inbox board first.");
      return;
    }
    try {
      const report = await this.withAllume((api) => this.syncWith(api, true));
      const body = report.preview.length
        ? report.preview.join("\n\n")
        : `Nothing new. ${report.seen} cards on the board, ${report.skipped} already synced or skipped.`;
      new TextModal(this.app, "Next Allume sync would add", body).open();
    } catch (e) {
      this.notifyError(friendlyError(e), 10_000);
    }
  }

  /** Everything needed to diagnose a mismatch with a new Allume release. */
  private async debugDump(): Promise<void> {
    try {
      const text = await this.withAllume(async (api) => {
        const out: Record<string, unknown> = {
          plugin: this.manifest.version,
          server: api.serverInfo,
          tools: api.toolNames().map((n) => ({ name: n, inputSchema: api.tool(n)?.inputSchema })),
        };
        if (this.hasInbox()) {
          try {
            await this.ensureBoards(api);
          } catch (e) {
            out.resolve_error = (e as Error).message;
          }
          out.inbox = { name: this.settings.inboxBoardName, id: this.settings.inboxBoardId };
          try {
            out.search_for_name = truncate(await api.search(this.settings.inboxBoardName || "Inbox", 20));
          } catch (e) {
            out.search_error = (e as Error).message;
          }
          try {
            out.list_workspaces = truncate(resultPayload(await api.call("list_workspaces", {})));
          } catch (e) {
            out.list_workspaces_error = (e as Error).message;
          }
        }
        let firstBoard = "";
        try {
          const boards = await this.sourceBoards(api);
          out.source_boards = boards;
          firstBoard = boards[0]?.id ?? "";
        } catch (e) {
          out.source_error = (e as Error).message;
        }
        if (firstBoard) {
          const args = api.boardContentArgs(firstBoard);
          const board = await api.call("board_content", args);
          out.board_content = { args, result: board };
          const cards = await api.boardCards(firstBoard);
          out.parsed_cards = cards.map(({ raw, ...c }) => c);
          const sample = [];
          for (const c of cards.filter((x) => x.kind !== "board").slice(0, 3)) {
            const a = api.cardContentArgs(c.id);
            sample.push({ card: c.id, args: a, result: truncate(resultPayload(await api.call("card_content", a))) });
          }
          out.card_content_samples = sample;
        }
        return JSON.stringify(out, null, 2);
      });
      new TextModal(this.app, "Raw Allume responses", text).open();
    } catch (e) {
      this.notifyError(friendlyError(e), 10_000);
    }
  }

  // ------------------------------------------------------------ ui bits

  private setStatus(text: string, tooltip = "Click to sync Allume now"): void {
    this.statusEl.empty();
    const icon = this.statusEl.createSpan({ cls: "allume-inbox-icon" });
    setIcon(icon, "inbox");
    this.statusEl.createSpan({ text: ` ${text.replace(/^Allume\s*/, "")}` });
    this.statusEl.setAttr("aria-label", tooltip);
    this.statusEl.setAttr("data-tooltip-position", "top");
  }

  private notifyError(err: AllumeError, timeout: number): void {
    new Notice(`Allume Inbox: ${err.message}${err.hint ? `\n${err.hint}` : ""}`, timeout);
  }
}

function truncate(v: unknown): unknown {
  const s = JSON.stringify(v);
  if (s && s.length > 4000) return `${s.slice(0, 4000)}… (${s.length} chars)`;
  return v;
}
