// Thin, schema-aware wrapper over Allume's MCP tools.
//
// Tool names come from allume.com/mcp-setup. Argument names are read from each
// tool's inputSchema at runtime, so small naming differences between Allume
// releases don't break the plugin.

import { McpClient, McpError, type JsonSchema, type ToolInfo, type ToolResult } from "./mcp";
import { contentFromResult, extractCards, pick, resultPayload, type CardContent, type CardRef } from "./cards";

/** The id to pass to board_content for a sub-board card. */
export function boardIdOf(c: CardRef): string {
  return c.docId ?? c.id;
}

const NOT_FOUND = /not ?found|could not find|couldn't find|no board|no card|no document|invalid (board|card|document)/i;

export class AllumeError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "AllumeError";
  }
}

/** What the sync engine needs from Allume. Faked in tests. */
export interface AllumeSource {
  boardCards(boardId: string): Promise<CardRef[]>;
  cardContent(ref: CardRef): Promise<CardContent>;
  cardFile(ref: CardRef): Promise<CardContent>;
  /** Whether Allume can perform this clean-up on synced cards. */
  canCleanUp(action: "delete" | "move"): boolean;
  /** Remove a synced card (soft delete) or move it out of the Inbox onto a board. */
  cleanUp(ref: CardRef, action: "delete" | "move", targetBoardId: string): Promise<void>;
}

interface ArgSlot {
  name: string;
  isArray: boolean;
}

function propsOf(tool?: ToolInfo): Record<string, JsonSchema> {
  return tool?.inputSchema?.properties ?? {};
}

function isArrayType(s?: JsonSchema): boolean {
  if (!s) return false;
  return s.type === "array" || (Array.isArray(s.type) && s.type.includes("array"));
}

/** Choose the argument that best matches a list of candidate names. */
export function slotFor(tool: ToolInfo | undefined, candidates: string[], exclude: string[] = []): ArgSlot {
  const props = propsOf(tool);
  const names = Object.keys(props).filter((n) => !exclude.includes(n));
  for (const c of candidates) {
    if (names.includes(c)) return { name: c, isArray: isArrayType(props[c]) };
  }
  const lower = names.map((n) => n.toLowerCase());
  for (const c of candidates) {
    const i = lower.indexOf(c.toLowerCase());
    if (i >= 0) return { name: names[i], isArray: isArrayType(props[names[i]]) };
  }
  const required = (tool?.inputSchema?.required ?? []).filter((n) => !exclude.includes(n));
  if (required.length === 1) return { name: required[0], isArray: isArrayType(props[required[0]]) };
  return { name: candidates[0], isArray: false };
}

function setSlot(args: Record<string, unknown>, slot: ArgSlot, value: string): void {
  args[slot.name] = slot.isArray ? [value] : value;
}

const BOARD_ID = ["board_id", "boardId", "board", "id", "document_id", "documentId", "doc_id"];
const CARD_ID = ["card_id", "cardId", "card", "id", "document_id", "documentId", "doc_id"];
const QUERY = ["query", "q", "text", "term", "search", "terms"];

/** Arguments that ask card_content for the file rather than the summary. */
export function fileModeArgs(tool: ToolInfo | undefined): Record<string, unknown> | null {
  const props = propsOf(tool);
  for (const [name, schema] of Object.entries(props)) {
    const en = (schema.enum ?? []).map(String);
    if (en.includes("file-uri")) return { [name]: "file-uri" };
    if (en.includes("file_uri")) return { [name]: "file_uri" };
  }
  for (const [name, schema] of Object.entries(props)) {
    const en = (schema.enum ?? []).map(String);
    if (en.includes("raw")) return { [name]: "raw" };
  }
  if (props.raw) return { raw: true };
  for (const name of ["contents", "mode", "output"]) {
    if (props[name]) return { [name]: "raw" };
  }
  return null;
}

function errorText(res: ToolResult): string {
  const t = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
  return t || "Allume returned an error";
}

export function friendlyError(e: unknown): AllumeError {
  if (e instanceof AllumeError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.toLowerCase();
  if (m.includes("not found at")) {
    return new AllumeError(msg, "Check the helper path in settings. Copy it from Allume → Preferences → MCP.");
  }
  if (m.includes("not running")) {
    return new AllumeError("Allume isn't running.", "Open Allume, or turn on “Launch Allume if needed”.");
  }
  if (m.includes("disabled") || m.includes("not enabled")) {
    return new AllumeError("Allume's MCP server is turned off.", "Turn it on in Allume → Preferences → MCP.");
  }
  if (m.includes("read-only") || m.includes("readonly") || m.includes("read only")) {
    return new AllumeError(
      "Allume's MCP is read-only.",
      "Switch MCP to read-write in Allume → Preferences → MCP, or set “After sync” to Keep.",
    );
  }
  if (NOT_FOUND.test(m) && !m.includes("helper not found")) {
    return new AllumeError(msg, "Check the board name in Allume Inbox settings. You can type the board's name, such as Inbox.");
  }
  if (e instanceof McpError && e.code === -32003) {
    return new AllumeError(msg, "Allume took too long to answer. Is it busy syncing?");
  }
  return new AllumeError(msg);
}

export class AllumeMcp implements AllumeSource {
  private tools = new Map<string, ToolInfo>();
  /** Optional sink for a request/response trace (debug log). */
  logger: ((line: string) => void) | null = null;
  private workspaceCache: Record<string, unknown>[] | null = null;
  /** Workspace of each built-in inbox id, for tools that need workspace_id. */
  private inboxWorkspace = new Map<string, string>();
  /** Root board of the workspace each inbox belongs to. */
  private inboxRoot = new Map<string, string>();
  /** How each inbox id was last read successfully, so later syncs go straight there. */
  private inboxReader = new Map<string, string>();

  private constructor(private readonly client: McpClient) {}

  static async connect(
    helperPath: string,
    timeoutMs = 30_000,
    version = "0.0.0",
    logger: ((line: string) => void) | null = null,
  ): Promise<AllumeMcp> {
    let client: McpClient;
    try {
      client = await McpClient.connect(helperPath, ["mcp"], {
        timeoutMs,
        clientName: "obsidian-allume-inbox",
        clientVersion: version,
      });
    } catch (e) {
      throw friendlyError(e);
    }
    const api = new AllumeMcp(client);
    api.logger = logger;
    logger?.(`connected: ${JSON.stringify(client.serverInfo)}`);
    try {
      for (const t of await client.listTools()) api.tools.set(t.name, t);
    } catch (e) {
      client.close();
      throw friendlyError(e);
    }
    logger?.(
      `tools: ${JSON.stringify([...api.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })))}`,
    );
    if (api.tools.size === 0) {
      client.close();
      throw new AllumeError("Allume's MCP server offered no tools.", "Turn on MCP in Allume → Preferences → MCP.");
    }
    return api;
  }

  get serverInfo(): unknown {
    return this.client.serverInfo;
  }

  toolNames(): string[] {
    return [...this.tools.keys()].sort();
  }

  tool(name: string): ToolInfo | undefined {
    return this.tools.get(name);
  }

  close(): void {
    this.client.close();
  }

  /** Raw call, used by the debug dump. */
  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.tools.has(name)) {
      throw new AllumeError(`Allume has no “${name}” tool.`, "Update Allume, or check its MCP mode (read-only hides write tools).");
    }
    let res: ToolResult;
    this.logger?.(`-> ${name} ${JSON.stringify(args)}`);
    try {
      res = await this.client.callTool(name, args);
    } catch (e) {
      this.logger?.(`xx ${name} ${(e as Error).message}`);
      throw friendlyError(e);
    }
    this.logger?.(`<- ${name}${res.isError ? " (error)" : ""} ${clip(JSON.stringify(res))}`);
    if (res.isError) throw friendlyError(new Error(errorText(res)));
    return res;
  }

  boardContentArgs(boardId: string): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    setSlot(args, slotFor(this.tool("board_content"), BOARD_ID), boardId);
    return args;
  }

  cardContentArgs(cardId: string, fileMode = false): Record<string, unknown> {
    const tool = this.tool("card_content");
    const args: Record<string, unknown> = {};
    setSlot(args, slotFor(tool, CARD_ID), cardId);
    if (fileMode) Object.assign(args, fileModeArgs(tool) ?? {});
    return args;
  }

  async boardCards(boardId: string): Promise<CardRef[]> {
    if (!this.inboxWorkspace.has(boardId)) {
      const res = await this.call("board_content", this.boardContentArgs(boardId));
      return extractCards(resultPayload(res));
    }
    return this.inboxCards(boardId);
  }

  /**
   * Allume's built-in Inbox is not a board, so board_content may refuse its id.
   * Try the ways it might be readable, remember the one that works.
   */
  private async inboxCards(inboxId: string): Promise<CardRef[]> {
    const ws = this.inboxWorkspace.get(inboxId) ?? "";
    const attempts: [string, () => Promise<ToolResult>][] = [];
    const wsKey = (t?: ToolInfo) => Object.keys(propsOf(t)).find((k) => /^workspace(_id|Id)?$/i.test(k));

    attempts.push(["board_content", () => this.call("board_content", this.boardContentArgs(inboxId))]);
    const bcWs = wsKey(this.tool("board_content"));
    if (bcWs && ws) {
      attempts.push(["board_content+workspace", () => this.call("board_content", { ...this.boardContentArgs(inboxId), [bcWs]: ws })]);
    }
    // Any tool that is about the inbox.
    for (const t of this.tools.values()) {
      if (!/inbox/i.test(t.name)) continue;
      const args: Record<string, unknown> = {};
      const props = Object.keys(propsOf(t));
      const k = wsKey(t);
      if (k && ws) args[k] = ws;
      const idKey = props.find((p) => /^(inbox_?id|inboxId|id|board_?id|boardId)$/i.test(p));
      if (idKey) args[idKey] = inboxId;
      attempts.push([t.name, () => this.call(t.name, args)]);
    }
    attempts.push(["card_content", () => this.call("card_content", this.cardContentArgs(inboxId))]);
    // Last resort: the Inbox shown as a sub-board on the workspace's root board.
    const root = this.inboxRoot.get(inboxId);
    if (root) {
      attempts.push([
        "root-subboard",
        async () => {
          const top = await this.boardCards(root);
          const inbox = top.find((c) => c.kind === "board" && c.title && norm(c.title) === "inbox");
          if (!inbox) throw new AllumeError(`No board called Inbox on the root board ${root}`);
          this.logger?.(`inbox ${inboxId}: using root sub-board “${inbox.title}” ${boardIdOf(inbox)}`);
          return this.call("board_content", this.boardContentArgs(boardIdOf(inbox)));
        },
      ]);
    }

    const known = this.inboxReader.get(inboxId);
    if (known) attempts.sort((a, b) => Number(b[0] === known) - Number(a[0] === known));

    let firstErr: unknown = null;
    for (const [label, run] of attempts) {
      try {
        const payload = resultPayload(await run());
        const cards = extractCards(payload);
        // card_content on a container should list its children; an empty
        // result from it is not proof of an empty inbox.
        if (label === "card_content" && !cards.length) {
          this.logger?.(`inbox ${inboxId}: card_content gave no card list`);
          continue;
        }
        this.inboxReader.set(inboxId, label);
        this.logger?.(`inbox ${inboxId}: read with ${label}, ${cards.length} cards`);
        return cards;
      } catch (e) {
        firstErr ??= e;
      }
    }
    throw friendlyError(
      firstErr ?? new Error(`Couldn't read the Allume Inbox ${inboxId}`),
    );
  }

  /** card_content by the card id, falling back to its document id. */
  private async cardCall(ref: CardRef, fileMode: boolean): Promise<ToolResult> {
    try {
      return await this.call("card_content", this.cardContentArgs(ref.id, fileMode));
    } catch (e) {
      if (ref.docId && ref.docId !== ref.id && NOT_FOUND.test((e as Error).message)) {
        return this.call("card_content", this.cardContentArgs(ref.docId, fileMode));
      }
      throw e;
    }
  }

  async cardContent(ref: CardRef): Promise<CardContent> {
    return contentFromResult(await this.cardCall(ref, false), ref);
  }

  async cardFile(ref: CardRef): Promise<CardContent> {
    if (!fileModeArgs(this.tool("card_content"))) return {};
    return contentFromResult(await this.cardCall(ref, true), ref, true);
  }

  async workspaces(): Promise<Record<string, unknown>[]> {
    if (this.workspaceCache) return this.workspaceCache;
    const list: Record<string, unknown>[] = [];
    try {
      const payload = resultPayload(await this.call("list_workspaces", {}));
      const arr = Array.isArray(payload) ? payload : [];
      for (const w of arr) if (w && typeof w === "object") list.push(w as Record<string, unknown>);
      if (!arr.length) walkObjects(payload, (o) => void (pick(o, ["id"]) && list.push(o)));
    } catch {
      /* older Allume without list_workspaces */
    }
    this.workspaceCache = list;
    return list;
  }

  canMove(): boolean {
    return this.tools.has("delete") || this.tools.has("inbox_move");
  }

  canCleanUp(action: "delete" | "move"): boolean {
    if (action === "delete") return this.tools.has("delete");
    // inbox_move only works for cards in the built-in Inbox.
    return this.tools.has("inbox_move") && this.inboxWorkspace.size > 0;
  }

  private movedCount = 0;

  async cleanUp(ref: CardRef, action: "delete" | "move", targetBoardId: string): Promise<void> {
    if (action === "delete") {
      const args: Record<string, unknown> = {};
      setSlot(args, slotFor(this.tool("delete"), ["id", "card_id", "cardId"]), ref.id);
      await this.call("delete", args);
      return;
    }
    const ws =
      pick(ref.raw, ["workspaceId", "workspace_id"]) ??
      this.inboxWorkspace.get(pick(ref.raw, ["parentDocumentId", "parent_document_id"]) ?? "") ??
      "";
    if (!ws) throw new AllumeError("Only cards in Allume's built-in Inbox can be moved to a board.");
    // Stack moved cards in a loose grid so they don't land on top of each other.
    const n = this.movedCount++;
    const position = { x: 80 + (n % 4) * 320, y: 80 + Math.floor(n / 4) * 280 };
    await this.call("inbox_move", { workspace_id: ws, board_id: targetBoardId, moves: [{ card_id: ref.id, position }] });
  }

  /**
   * Turn what the user typed (a board name such as "Inbox", or an id) into a
   * board id. Tries it as an id first, then search, then walks the workspaces.
   */
  async resolveBoard(nameOrId: string): Promise<{ id: string; title: string }> {
    const wanted = nameOrId.trim();
    if (!wanted) throw new AllumeError("No board name given.");
    // An id that Allume accepts and that has cards wins straight away. An empty
    // result is kept as a fallback, in case Allume answers unknown ids with [].
    let fallback: { id: string; title: string } | null = null;
    try {
      const cards = await this.boardCards(wanted);
      if (cards.length) return { id: wanted, title: wanted };
      fallback = { id: wanted, title: wanted };
    } catch {
      /* not an id; treat it as a name */
    }
    const name = norm(wanted);
    const verify = async (id: string) => {
      try {
        await this.boardCards(id);
        return true;
      } catch {
        return false;
      }
    };

    const workspaces = await this.workspaces();

    // 1. Walk each workspace's boards from its root, matching sub-board titles.
    const queue: string[] = [];
    for (const w of workspaces) {
      const root = pick(w, ["rootBoardId", "root_board_id", "homeBoardId", "home_board_id", "boardId", "board_id"]);
      if (root) queue.push(root);
    }
    const seen = new Set<string>();
    let budget = 60;
    for (let depth = 0; depth < 3 && queue.length && budget > 0; depth++) {
      const next: string[] = [];
      for (const id of queue.splice(0)) {
        if (seen.has(id) || budget-- <= 0) continue;
        seen.add(id);
        let cards: CardRef[];
        try {
          cards = await this.boardCards(id);
        } catch {
          continue;
        }
        for (const c of cards) {
          if (c.kind !== "board") continue;
          if (c.title && norm(c.title) === name && (await verify(boardIdOf(c)))) {
            return { id: boardIdOf(c), title: c.title };
          }
          next.push(boardIdOf(c));
        }
      }
      queue.push(...next);
    }

    // 2. Allume's built-in inbox, for "Inbox".
    if (name === "inbox" || name === "personal inbox") {
      const key = name === "inbox" ? ["inboxId", "inbox_id"] : ["personalInboxId", "personal_inbox_id"];
      for (const w of workspaces) {
        const id = pick(w, key);
        if (id && (await verify(id))) return { id, title: name === "inbox" ? "Inbox" : "Personal inbox" };
      }
    }

    // 3. Search, once per workspace when Allume asks for one.
    if (this.tools.has("search")) {
      const wsIds = workspaces.map((w) => pick(w, ["id"])).filter((x): x is string => Boolean(x));
      for (const ws of wsIds.length ? wsIds : [undefined]) {
        try {
          const candidates: { id: string; title: string }[] = [];
          walkObjects(await this.search(wanted, 100, ws), (o) => {
            const doc = (o.document ?? null) as Record<string, unknown> | null;
            const title = pick(o, ["title", "name"]) ?? pick(doc, ["title", "name"]);
            const type = [pick(o, ["type", "kind", "documentType"]), pick(doc, ["documentType", "type"])].join("/").toLowerCase();
            const id = pick(doc, ["id"]) ?? pick(o, ["board_id", "boardId", "document_id", "documentId", "id"]);
            if (id && title && norm(title) === name && type.includes("board")) candidates.push({ id, title });
          });
          for (const c of candidates) if (await verify(c.id)) return c;
        } catch {
          /* try the next workspace */
        }
      }
    }

    if (fallback) return fallback;
    throw new AllumeError(
      `Couldn't find an Allume board named “${wanted}”.`,
      "Check the spelling, or use Choose… in Allume Inbox settings.",
    );
  }

  /**
   * The built-in Inbox of each workspace (and the personal inbox, in shared
   * workspaces). Optionally only workspaces whose title matches.
   */
  async inboxBoards(workspaceTitle = ""): Promise<{ id: string; title: string }[]> {
    const want = norm(workspaceTitle);
    const out: { id: string; title: string }[] = [];
    const seen = new Set<string>();
    for (const w of await this.workspaces()) {
      const wsTitle = (pick(w, ["title", "name"]) ?? "").trim();
      if (want && norm(wsTitle) !== want) continue;
      // list_inbox returns the shared and personal inbox together, so one entry
      // per workspace is enough when it exists.
      const kinds = [
        [["inboxId", "inbox_id", "sharedInboxId"], "Inbox"],
        [["personalInboxId", "personal_inbox_id"], "Personal inbox"],
      ] as const;
      const wanted = this.tools.has("list_inbox") ? kinds.slice(0, 1) : kinds;
      for (const [key, label] of wanted) {
        const id =
          pick(w, [...key]) ??
          (wanted.length === 1 ? pick(w, ["personalInboxId", "personal_inbox_id"]) : undefined);
        if (id && !seen.has(id)) {
          seen.add(id);
          this.inboxWorkspace.set(id, pick(w, ["id"]) ?? "");
          const root = pick(w, ["rootBoardId", "root_board_id"]);
          if (root) this.inboxRoot.set(id, root);
          out.push({ id, title: `${wsTitle || "Workspace"} · ${label}` });
        }
      }
    }
    return out;
  }

  async search(query: string, limit = 30, workspaceId?: string): Promise<unknown> {
    const tool = this.tool("search");
    const args: Record<string, unknown> = {};
    setSlot(args, slotFor(tool, QUERY), query);
    if (propsOf(tool).limit) args.limit = limit;
    if (workspaceId) {
      const ws = Object.keys(propsOf(tool)).find((k) => /^workspace(_id|Id)?$/i.test(k)) ?? "workspace_id";
      args[ws] = workspaceId;
    }
    return resultPayload(await this.call("search", args));
  }
}

function norm(s: string): string {
  return s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function clip(s: string, max = 12000): string {
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
}

/** Visit every object nested anywhere in a payload. */
export function walkObjects(v: unknown, fn: (o: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 8 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const x of v) walkObjects(x, fn, depth + 1);
    return;
  }
  fn(v as Record<string, unknown>);
  for (const x of Object.values(v as Record<string, unknown>)) walkObjects(x, fn, depth + 1);
}
