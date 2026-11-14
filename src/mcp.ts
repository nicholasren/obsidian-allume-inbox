// Minimal Model Context Protocol client over stdio.
// No SDK dependency: newline-delimited JSON-RPC 2.0, which is all the
// stdio transport needs. Kept free of Obsidian imports so it runs under Node tests.

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  description?: string;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

export interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
}

export interface ToolResult {
  content: ContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

export class McpError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = "McpError";
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: number;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

// window timers inside Obsidian (popout-safe); globalThis under Node tests.
const host = (typeof window !== "undefined" ? window : globalThis) as unknown as {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
};

export interface McpClientOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  clientName?: string;
  clientVersion?: string;
  /** A longer message from the helper fails the pending requests. */
  maxMessageChars?: number;
}

const PROTOCOL_VERSION = "2025-06-18";

export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderrTail = "";
  private exited = false;
  serverInfo: unknown = null;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly opts: McpClientOptions = {},
  ) {}

  static async connect(command: string, args: string[], opts: McpClientOptions = {}): Promise<McpClient> {
    const client = new McpClient(command, args, opts);
    await client.start();
    return client;
  }

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? 30_000;
  }

  // Room for a 256 MB attachment sent as base64.
  private get maxMessageChars(): number {
    return this.opts.maxMessageChars ?? 400_000_000;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const proc = spawn(this.command, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.opts.env ?? process.env,
      });
      this.proc = proc;
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => this.onData(chunk));
      proc.stderr.on("data", (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-500);
      });
      proc.on("error", (err: NodeJS.ErrnoException) => {
        const e =
          err.code === "ENOENT"
            ? new McpError(`Allume helper not found at ${this.command}`, -32000)
            : new McpError(`Could not start Allume helper: ${err.message}`, -32000);
        this.failAll(e);
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
      proc.on("exit", (code, signal) => {
        this.exited = true;
        const detail = this.stderrTail.trim();
        this.failAll(
          new McpError(
            `Allume helper exited (${signal ?? code})${detail ? `: ${detail}` : ""}`,
            -32001,
          ),
        );
      });
      proc.on("spawn", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });

    const init = (await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: this.opts.clientName ?? "allume-inbox",
        version: this.opts.clientVersion ?? "0.0.0",
      },
    })) as { serverInfo?: unknown };
    this.serverInfo = init?.serverInfo ?? null;
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<ToolInfo[]> {
    const tools: ToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = (await this.request("tools/list", cursor ? { cursor } : {})) as {
        tools?: ToolInfo[];
        nextCursor?: string;
      };
      tools.push(...(res?.tools ?? []));
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const res = (await this.request("tools/call", { name, arguments: args })) as ToolResult;
    return {
      content: Array.isArray(res?.content) ? res.content : [],
      structuredContent: res?.structuredContent,
      isError: Boolean(res?.isError),
    };
  }

  close(): void {
    this.failAll(new McpError("Client closed", -32002));
    if (this.proc && !this.exited) {
      try {
        this.proc.stdin.end();
      } catch {
        /* ignore */
      }
      const p = this.proc;
      host.setTimeout(() => {
        if (!this.exited) p.kill();
      }, 500);
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.proc || this.exited) {
      return Promise.reject(new McpError("Allume helper is not running", -32001));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = host.setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`Timed out waiting for Allume (${method})`, -32003));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: unknown): void {
    this.proc?.stdin.write(JSON.stringify(msg) + "\n");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      if (nl > this.maxMessageChars) return this.overflow();
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        continue; // stray log line on stdout; ignore
      }
      this.onMessage(msg);
    }
    if (this.buffer.length > this.maxMessageChars) this.overflow();
  }

  private overflow(): void {
    this.buffer = "";
    this.failAll(new McpError(`Allume sent a message too large to read (over ${this.maxMessageChars} characters)`, -32004));
    this.proc?.kill();
  }

  private onMessage(msg: RpcMessage): void {
    // Response to one of our requests
    if (msg && msg.id !== undefined && msg.method === undefined) {
      const id = Number(msg.id);
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      host.clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new McpError(msg.error.message ?? "MCP error", msg.error.code, msg.error.data));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    // Request from the server (ping, roots/list, ...)
    if (msg && msg.id !== undefined && typeof msg.method === "string") {
      if (msg.method === "ping") {
        this.send({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else if (msg.method === "roots/list") {
        this.send({ jsonrpc: "2.0", id: msg.id, result: { roots: [] } });
      } else {
        this.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method not supported: ${msg.method}` },
        });
      }
    }
    // Notifications from the server are ignored.
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      host.clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}
