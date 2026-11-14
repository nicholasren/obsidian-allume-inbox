#!/usr/bin/env node
// A stand-in for `allume-cli mcp`: newline-delimited JSON-RPC over stdio.
// Argument names deliberately differ from the plugin's first guesses so the
// schema-driven mapping gets exercised.

import { createInterface } from "node:readline";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const READONLY = process.env.FAKE_READONLY === "1";
const INBOX_MODE = process.env.FAKE_INBOX || ""; // "" | tool | card
const INBOX_IDS = { inbox: "w1", "w2-inbox": "w2" };

const STYLE = process.env.FAKE_STYLE || "json"; // json | structured | markdown

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);
const PDF = Buffer.from("%PDF-1.4\n% fake pdf for tests\n%%EOF\n");
const tmp = mkdtempSync(join(tmpdir(), "fake-allume-"));

const deleted = [];
const boards = {
  inbox: [
    { id: "c-note-1", type: "note", title: "", body: "Idea: capture to Obsidian via MCP", created_at: "2026-11-14T00:01:00Z" },
    { id: "c-url-1", type: "url", title: "Allume CLI", url: "https://allume.com/cli-setup", created_at: "2026-11-14T00:02:00Z" },
    { id: "c-img-1", type: "image", title: "whiteboard.png", created_at: "2026-11-14T00:03:00Z", bytes: PNG },
    { id: "c-pdf-1", type: "pdf", title: "Spec", filename: "spec.pdf", created_at: "2026-11-14T00:04:00Z", bytes: PDF },
    { id: "b-sub", type: "board", title: "Sub board", created_at: "2026-11-14T00:00:30Z" },
    { id: "c-note-2", type: "note", title: "Shopping", body: "milk\neggs\n\nbread", created_at: "2026-11-14T00:05:00Z" },
  ],
  synced: [],
  home: [
    { id: "home:card-proj", type: "subBoard", title: "Projects", created_at: "2026-01-01T00:00:00Z", document: { documentType: "board", id: "b-projects", title: "Projects" } },
    { id: "home:card-inb", type: "subBoard", title: "Inbox", created_at: "2026-01-01T00:00:00Z", document: { documentType: "board", id: INBOX_MODE === "root" ? "inbox-board" : "inbox", title: "Inbox" } },
  ],
  "w2-root": [],
  "w2-inbox": [
    { id: "c-w2-1", type: "note", title: "", body: "From the other workspace", created_at: "2026-11-14T00:06:00Z" },
  ],
  "b-projects": [],
};
const byId = () => Object.fromEntries(Object.values(boards).flat().map((c) => [c.id, c]));

const tools = [
  { name: "list_workspaces", description: "List workspaces", inputSchema: { type: "object", properties: {} } },
  {
    name: "search",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, workspace_id: { type: "string" } }, required: ["query"] },
  },
  {
    name: "board_content",
    inputSchema: {
      type: "object",
      properties: { board: { type: "string" }, filter: { type: "string" } },
      required: ["board"],
    },
  },
  {
    name: "card_content",
    inputSchema: {
      type: "object",
      properties: { card: { type: "string" }, contents: { type: "string", enum: process.env.FAKE_FILEMODE === "raw" ? ["summary", "raw"] : ["summary", "raw", "file-uri"] } },
      required: ["card"],
    },
  },
];
if (INBOX_MODE === "tool") {
  tools.push({
    name: "inbox_content",
    description: "Lists the cards in a workspace inbox",
    inputSchema: { type: "object", properties: { workspace_id: { type: "string" } }, required: ["workspace_id"] },
  });
}
if (INBOX_MODE === "list") {
  tools.push({
    name: "list_inbox",
    description: "Returns the cards the user sees in the inbox UI",
    inputSchema: { type: "object", properties: { workspace_id: { type: "string" } }, required: ["workspace_id"] },
  });
}
if (!READONLY) {
  // Real Allume v4 schemas: card_move only repositions; delete is a soft delete.
  tools.push({
    name: "card_move",
    inputSchema: { type: "object", properties: { card_id: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["card_id"] },
  });
  tools.push({ name: "delete", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } });
  tools.push({ name: "undelete", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } });
  if (INBOX_MODE === "list") {
    tools.push({
      name: "inbox_move",
      inputSchema: {
        type: "object",
        properties: { workspace_id: { type: "string" }, board_id: { type: "string" }, moves: { type: "array" } },
        required: ["workspace_id", "board_id", "moves"],
      },
    });
  }
}

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }] });


function boardResult(id, viaInbox = false) {
  if (INBOX_MODE === "root" && id === "inbox-board") return boardResult("inbox", true);
  if (INBOX_MODE && INBOX_IDS[id] && !viaInbox) {
    return { isError: true, content: [{ type: "text", text: `error: notFound: No board with id ${id}` }] };
  }
  if (!boards[id]) return { isError: true, content: [{ type: "text", text: `error: notFound: No board with id ${id}` }] };
  if (STYLE === "allume") {
    // Real Allume v4 shape: placement id, kind, createdAt, and the document behind the card.
    const items = boards[id].map((c) => ({
      id: `p-${c.id}`,
      kind: c.type,
      title: c.title,
      createdAt: c.created_at,
      document: c.document ?? { documentType: c.type, id: c.id, title: c.title },
    }));
    return text(items);
  }
  const cards = (boards[id] || []).map(({ id, type, title, created_at, document }) => ({ id, type, title, created_at, document }));
  if (STYLE === "structured") return { content: [{ type: "text", text: "ok" }], structuredContent: { cards } };
  if (STYLE === "markdown") {
    const rows = cards.map((c) => `| ${c.id} | ${c.type} | ${c.title} | ${c.created_at} |`);
    return text(["| ID | Type | Title | Created |", "|---|---|---|---|", ...rows].join("\n"));
  }
  return text({ board: id, cards });
}

function cardResult(args) {
  if (INBOX_MODE === "card" && INBOX_IDS[args.card]) return boardResult(args.card, true);
  if (INBOX_MODE === "root" && INBOX_IDS[args.card]) return { isError: true, content: [{ type: "text", text: `error: notFound: No card with id ${args.card}` }] };
  const c = byId()[args.card];
  if (!c && STYLE === "allume") return { isError: true, content: [{ type: "text", text: `error: notFound: No card with id ${args.card}` }] };
  if (!c) return { isError: true, content: [{ type: "text", text: `No card ${args.card}` }] };
  if (args.contents === "file-uri" && c.bytes) {
    const p = join(tmp, c.filename || `${c.id}.${c.type === "image" ? "png" : "bin"}`);
    writeFileSync(p, c.bytes);
    return text({ id: c.id, path: `file://${p}` });
  }
  if (args.contents === "raw" && c.bytes) {
    return { content: [{ type: "resource", resource: { uri: `allume://${c.id}`, mimeType: c.type === "image" ? "image/png" : "application/pdf", blob: c.bytes.toString("base64") } }] };
  }
  return text({ id: c.id, type: c.type, title: c.title, body: c.body, url: c.url, filename: c.filename });
}

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return null;
  switch (method) {
    case "initialize":
      return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-allume", version: "4.0" } };
    case "tools/list":
      return { tools };
    case "tools/call": {
      const { name, arguments: args = {} } = params;
      if (name === "board_content") return boardResult(args.board);
      if (name === "delete") {
        const all = byId();
        if (!all[args.id]) return { isError: true, content: [{ type: "text", text: `error: notFound: No card ${args.id}` }] };
        for (const k of Object.keys(boards)) boards[k] = boards[k].filter((x) => x.id !== args.id);
        deleted.push(args.id);
        return text({ ok: true });
      }
      if (name === "list_inbox") {
        const id = Object.keys(INBOX_IDS).find((k) => INBOX_IDS[k] === args.workspace_id);
        const items = (boards[id] || []).map((c) => ({ id: c.id, kind: c.type, title: c.title, createdAt: c.created_at, workspaceId: args.workspace_id, parentDocumentId: id }));
        return text({ workspaceId: args.workspace_id, sharedInboxId: id, personalInboxId: null, items });
      }
      if (name === "inbox_move") {
        const all = byId();
        const inboxId = Object.keys(INBOX_IDS).find((k) => INBOX_IDS[k] === args.workspace_id);
        for (const m of args.moves) {
          if (!(boards[inboxId] || []).some((c) => c.id === m.card_id)) {
            return { isError: true, content: [{ type: "text", text: `error: notInInbox: ${m.card_id}` }] };
          }
        }
        if (!boards[args.board_id]) return { isError: true, content: [{ type: "text", text: `error: notFound: No board with id ${args.board_id}` }] };
        for (const m of args.moves) {
          const c = all[m.card_id];
          boards[inboxId] = boards[inboxId].filter((x) => x.id !== m.card_id);
          boards[args.board_id].push({ ...c, id: `moved-${c.id}` });
        }
        return text({ items: args.moves.map((m) => ({ previousCardId: m.card_id, item: { id: `moved-${m.card_id}` } })) });
      }
      if (name === "inbox_content") {
        const id = Object.keys(INBOX_IDS).find((k) => INBOX_IDS[k] === args.workspace_id);
        return id ? boardResult(id, true) : { isError: true, content: [{ type: "text", text: "no workspace" }] };
      }
      if (name === "card_content") return cardResult(args);
      if (name === "list_workspaces")
        return text([
          { id: "w1", title: "Personal", rootBoardId: "home", inboxId: "inbox", personalInboxId: "w1-pinbox" },
          { id: "w2", title: "Work", rootBoardId: "w2-root", inboxId: "w2-inbox", personalInboxId: "w2-pinbox" },
        ]);
      if (name === "search") {
        if (!args.workspace_id) return { isError: true, content: [{ type: "text", text: "error: generic: Multiple workspaces are available. Pass workspace_id to choose one." }] };
        if (process.env.FAKE_SEARCH === "none") return text({ results: [] });
        return text({ results: [{ id: "c-x", type: "note", snippet: "Inbox zero", board_id: "b-projects", board_title: "Projects" }, { id: "inbox", type: "board", title: "Inbox" }] });
      }
      if (name === "card_move") {
        if (!byId()[args.card_id]) return { isError: true, content: [{ type: "text", text: `error: notFound: No card ${args.card_id}` }] };
        // repositioning only
        return text({ ok: true });
      }
      throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  let reply;
  try {
    const result = handle(msg);
    if (result === null) return;
    reply = { jsonrpc: "2.0", id: msg.id, result };
  } catch (e) {
    reply = { jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: e.message } };
  }
  process.stdout.write(JSON.stringify(reply) + "\n");
});
