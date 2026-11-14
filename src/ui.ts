import { App, Modal, Notice, PluginSettingTab, Setting, SuggestModal } from "obsidian";
import { AllumeMcp, boardIdOf } from "./allume";
import { extractCards, pick, resultPayload, type CardRef } from "./cards";
import { HELPER_CANDIDATES } from "./settings";
import type AllumeInboxPlugin from "./main";

// ---------------------------------------------------------------- board picker

interface BoardHit {
  id: string;
  title: string;
  type: string;
}

export class BoardPickerModal extends SuggestModal<BoardHit> {
  private api: AllumeMcp | null = null;
  private home: BoardHit[] = [];
  private status = "Connecting to Allume…";

  constructor(
    app: App,
    private readonly plugin: AllumeInboxPlugin,
    private readonly onPick: (hit: BoardHit) => void,
  ) {
    super(app);
    this.setPlaceholder("Search your Allume boards");
    this.emptyStateText = this.status;
  }

  onOpen(): void {
    void super.onOpen();
    void this.load();
  }

  onClose(): void {
    this.api?.close();
    this.api = null;
  }

  private async load(): Promise<void> {
    try {
      this.api = await this.plugin.connect();
      this.home = await this.topBoards();
      this.emptyStateText = this.home.length ? "No matches" : "Type a board name to search";
    } catch (e) {
      this.emptyStateText = `Couldn't reach Allume: ${(e as Error).message}`;
    }
    // Re-run the query so results appear without a keystroke.
    this.inputEl.dispatchEvent(new Event("input"));
  }

  private async topBoards(): Promise<BoardHit[]> {
    if (!this.api) return [];
    const out: BoardHit[] = [];
    try {
      const ws = resultPayload(await this.api.call("list_workspaces", {}));
      const list = Array.isArray(ws) ? ws : extractCards(ws).map((c) => c.raw);
      for (const w of list) {
        const home = pick(w, ["rootBoardId", "root_board_id", "homeBoardId", "home_board_id", "board_id", "boardId"]);
        if (!home) continue;
        const name = pick(w, ["name", "title"]) ?? "Workspace";
        out.push({ id: home, title: `${name} (home)`, type: "board" });
        try {
          for (const c of await this.api.boardCards(home)) {
            if (c.kind === "board") out.push({ id: boardIdOf(c), title: c.title ?? c.id, type: "board" });
          }
        } catch {
          /* workspace id may not be a board id */
        }
      }
    } catch {
      /* fall back to search only */
    }
    return out;
  }

  async getSuggestions(query: string): Promise<BoardHit[]> {
    const q = query.trim().toLowerCase();
    if (!this.api) return [];
    if (!q) return this.home;
    const local = this.home.filter((h) => h.title.toLowerCase().includes(q));
    let found: BoardHit[] = [];
    try {
      const payload = await this.api.search(query);
      found = extractCards(payload).map((c: CardRef) => ({
        id: boardIdOf(c),
        title: c.title ?? pick(c.raw, ["snippet", "text", "line"]) ?? c.id,
        type: c.rawType || "item",
      }));
    } catch {
      /* ignore */
    }
    const seen = new Set<string>();
    return [...local, ...found.sort((a, b) => Number(b.type.includes("board")) - Number(a.type.includes("board")))]
      .filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)))
      .slice(0, 50);
  }

  renderSuggestion(hit: BoardHit, el: HTMLElement): void {
    el.createDiv({ text: hit.title });
    el.createEl("small", { text: `${hit.type} · ${hit.id}`, cls: "allume-inbox-muted" });
  }

  onChooseSuggestion(hit: BoardHit): void {
    this.onPick(hit);
  }
}

// ---------------------------------------------------------------- text modal

export class TextModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly body: string,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    const pre = this.contentEl.createEl("pre", { cls: "allume-inbox-pre" });
    pre.setText(this.body);
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Copy")
        .setCta()
        .onClick(async () => {
          await navigator.clipboard.writeText(this.body);
          new Notice("Copied");
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------- settings tab

export class AllumeInboxSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: AllumeInboxPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    containerEl.createEl("p", {
      text: "Unofficial plugin. Needs Allume for Mac running, with MCP turned on in Allume → Preferences → MCP. Use read-write mode if you want cards moved after syncing.",
      cls: "setting-item-description",
    });

    // Connection
    new Setting(containerEl).setName("Connection").setHeading();
    new Setting(containerEl)
      .setName("Allume helper")
      .setDesc("Path to allume-cli. Copy it from Allume → Preferences → MCP.")
      .addText((t) =>
        t
          .setPlaceholder(HELPER_CANDIDATES[0])
          .setValue(s.helperPath)
          .onChange(async (v) => {
            s.helperPath = v.trim();
            await this.plugin.saveSettings();
          }),
      )
      .addButton((b) =>
        b.setButtonText("Detect").onClick(async () => {
          const found = this.plugin.detectHelper();
          if (found) {
            s.helperPath = found;
            await this.plugin.saveSettings();
            this.display();
            new Notice(`Found ${found}`);
          } else {
            new Notice("Couldn't find Allume. Is it installed in Applications?");
          }
        }),
      )
      .addButton((b) =>
        b
          .setButtonText("Test")
          .setCta()
          .onClick(() => void this.plugin.testConnection()),
      );

    // Source
    new Setting(containerEl).setName("Sync from").setHeading();
    new Setting(containerEl)
      .setName("Source")
      .setDesc("Allume's built-in Inbox, where quick captures land, or any board you name.")
      .addDropdown((d) =>
        d
          .addOption("inbox", "Allume Inbox (built-in)")
          .addOption("board", "A board")
          .setValue(s.source)
          .onChange(async (v) => {
            s.source = v as typeof s.source;
            await this.plugin.saveSettings();
            this.display();
          }),
      );
    if (s.source === "inbox") {
      new Setting(containerEl)
        .setName("Workspace")
        .setDesc("Only this workspace's Inbox. Leave blank to sync the Inbox of every workspace.")
        .addText((t) =>
          t
            .setPlaceholder("All workspaces")
            .setValue(s.workspace)
            .onChange(async (v) => {
              s.workspace = v.trim();
              await this.plugin.saveSettings();
            }),
        );
    }
    if (s.source === "board") new Setting(containerEl)
      .setName("Board")
      .setDesc(
        s.inboxBoardId
          ? `The Allume board your captures land in. Found as id ${s.inboxBoardId}.`
          : "The Allume board your captures land in. Type its name, such as Inbox.",
      )
      .addText((t) =>
        t
          .setPlaceholder("Inbox")
          .setValue(s.inboxBoardName || s.inboxBoardId)
          .onChange(async (v) => {
            s.inboxBoardName = v.trim();
            s.inboxBoardId = "";
            await this.plugin.saveSettings();
          }),
      )
      .addButton((b) =>
        b.setButtonText("Choose…").onClick(() =>
          new BoardPickerModal(this.app, this.plugin, (hit) => {
            s.inboxBoardId = hit.id;
            s.inboxBoardName = hit.title;
            void this.plugin.saveSettings().then(() => this.display());
          }).open(),
        ),
      );

    // Landing
    new Setting(containerEl).setName("Where captures land").setHeading();
    new Setting(containerEl)
      .setName("Mode")
      .setDesc("One note per capture, or a list under a heading in today's daily note.")
      .addDropdown((d) =>
        d
          .addOption("note", "One note per capture")
          .addOption("daily", "Today's daily note")
          .setValue(s.mode)
          .onChange(async (v) => {
            s.mode = v as typeof s.mode;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (s.mode === "note") {
      new Setting(containerEl)
        .setName("Folder")
        .setDesc("Created if missing.")
        .addText((t) =>
          t.setValue(s.noteFolder).onChange(async (v) => {
            s.noteFolder = v.trim().replace(/\/+$/, "");
            await this.plugin.saveSettings();
          }),
        );
    } else {
      const detected = this.plugin.dailyNoteConfig();
      new Setting(containerEl)
        .setName("Heading")
        .setDesc("Captures go at the end of this section. If it's missing, it's added at the end of the note.")
        .addText((t) =>
          t.setValue(s.heading).onChange(async (v) => {
            s.heading = v.trim() || "## Captured";
            await this.plugin.saveSettings();
          }),
        );
      new Setting(containerEl)
        .setName("Daily note folder")
        .setDesc(`Leave blank to use the Daily notes setting (currently “${detected.folder || "vault root"}”).`)
        .addText((t) =>
          t.setPlaceholder(detected.folder).setValue(s.dailyFolder).onChange(async (v) => {
            s.dailyFolder = v.trim().replace(/\/+$/, "");
            await this.plugin.saveSettings();
          }),
        );
      new Setting(containerEl)
        .setName("Daily note date format")
        .setDesc(`Leave blank to use the Daily notes setting (currently ${detected.format}).`)
        .addText((t) =>
          t.setPlaceholder(detected.format).setValue(s.dailyFormat).onChange(async (v) => {
            s.dailyFormat = v.trim();
            await this.plugin.saveSettings();
          }),
        );
    }

    // After sync
    new Setting(containerEl).setName("After sync").setHeading();
    new Setting(containerEl)
      .setName("In Allume")
      .setDesc(
        "What happens to a card once it's in your vault. Removing is a soft delete: Allume can restore it. Moving works for cards in Allume's built-in Inbox. Both need MCP in read-write mode.",
      )
      .addDropdown((d) =>
        d
          .addOption("keep", "Keep it")
          .addOption("delete", "Remove it (recoverable)")
          .addOption("move", "Move it to a board")
          .setValue(s.afterSync)
          .onChange(async (v) => {
            s.afterSync = v as typeof s.afterSync;
            await this.plugin.saveSettings();
            this.display();
          }),
      );
    if (s.afterSync === "move") {
      new Setting(containerEl)
        .setName("Move to board")
        .setDesc("Name or id of the board synced cards move to, such as In Obsidian. Create it in Allume first.")
        .addText((t) =>
          t
            .setPlaceholder("In Obsidian")
            .setValue(s.syncedBoardName || s.syncedBoardId)
            .onChange(async (v) => {
              s.syncedBoardName = v.trim();
              s.syncedBoardId = "";
              await this.plugin.saveSettings();
            }),
        )
        .addButton((b) =>
          b.setButtonText("Choose…").onClick(() =>
            new BoardPickerModal(this.app, this.plugin, (hit) => {
              s.syncedBoardId = hit.id;
              s.syncedBoardName = hit.title;
              void this.plugin.saveSettings().then(() => this.display());
            }).open(),
          ),
        );
    }

    // Schedule
    new Setting(containerEl).setName("Schedule").setHeading();
    new Setting(containerEl)
      .setName("Sync every (minutes)")
      .setDesc("0 means manual only.")
      .addText((t) =>
        t.setValue(String(s.intervalMinutes)).onChange(async (v) => {
          const n = Math.max(0, Math.min(1440, Math.round(Number(v)) || 0));
          s.intervalMinutes = n;
          await this.plugin.saveSettings();
          this.plugin.schedule();
        }),
      );
    new Setting(containerEl).setName("Sync when Obsidian starts").addToggle((t) =>
      t.setValue(s.syncOnStartup).onChange(async (v) => {
        s.syncOnStartup = v;
        await this.plugin.saveSettings();
      }),
    );
    new Setting(containerEl)
      .setName("Launch Allume if needed")
      .setDesc("Opens Allume in the background when it isn't running.")
      .addToggle((t) =>
        t.setValue(s.launchAllume).onChange(async (v) => {
          s.launchAllume = v;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl).setName("Notify on new captures").addToggle((t) =>
      t.setValue(s.notifyNew).onChange(async (v) => {
        s.notifyNew = v;
        await this.plugin.saveSettings();
      }),
    );

    // Advanced
    new Setting(containerEl).setName("Advanced").setHeading();
    new Setting(containerEl)
      .setName("Hidden card marker")
      .setDesc("Adds an invisible %%allume:id%% comment to each daily-note capture, so it is never added twice.")
      .addToggle((t) =>
        t.setValue(s.marker).onChange(async (v) => {
          s.marker = v;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Debug log")
      .setDesc("Writes every request to Allume and its answer to debug.log in this plugin's folder. Turn on when reporting a problem.")
      .addToggle((t) =>
        t.setValue(s.debugLog).onChange(async (v) => {
          s.debugLog = v;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Forget synced cards")
      .setDesc(`${s.syncedIds.length} cards are remembered as synced. Forgetting them makes the next sync pull every card on the board again.`)
      .addButton((b) =>
        b
          .setButtonText("Forget")
          .setWarning()
          .onClick(async () => {
            s.syncedIds = [];
            await this.plugin.saveSettings();
            this.display();
          }),
      );
  }
}
