/**
 * Minimal LSP-over-stdio client for external language servers
 * (rust-analyzer, jdtls): spawn → Content-Length framed JSON-RPC →
 * initialize/initialized handshake → didOpen + hover/definition requests +
 * publishDiagnostics collection. No dependencies; framing is hand-rolled.
 *
 * The frame parser is stream-independent (push bytes, get messages) so it is
 * unit-testable pure — it must survive frames split across chunks and
 * multiple frames merged into one chunk.
 *
 * Timeouts (spec'd): requests 15s (on timeout → null/[] and the provider is
 * marked "warming" — rust-analyzer may still be indexing); diagnostics wait
 * 10s for the first publishDiagnostics of the file; dispose sends
 * shutdown/exit and kills after a short grace.
 *
 * Coordinates: this module speaks 1-based lines/cols at its public surface
 * (types.ts convention) and converts to/from the 0-based LSP wire format.
 */

import { spawn, execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";

import type {
  Diag,
  DefResult,
  HoverResult,
  LangProvider,
  ProviderState,
} from "./types.ts";

// --- Framing (pure) -------------------------------------------------------------------

export interface FrameParser {
  /** Feed raw bytes from the wire; complete messages fire the callback in order. */
  push(chunk: Buffer | string): void;
}

/**
 * Incremental Content-Length frame parser. Handles headers/bodies split
 * across pushes and multiple frames per push. Malformed frames (no
 * Content-Length, bad JSON) are skipped without killing the stream.
 */
export function createFrameParser(
  onMessage: (message: unknown) => void,
): FrameParser {
  let buffer = Buffer.alloc(0);

  return {
    push(chunk: Buffer | string): void {
      buffer = Buffer.concat([
        buffer,
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      ]);

      for (;;) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const header = buffer.subarray(0, headerEnd).toString("ascii");
        const match = /content-length:\s*(\d+)/i.exec(header);
        if (!match) {
          // Unparseable header block: drop it and resync.
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + length) return; // body incomplete — wait

        const body = buffer.subarray(bodyStart, bodyStart + length);
        buffer = buffer.subarray(bodyStart + length);
        try {
          onMessage(JSON.parse(body.toString("utf8")));
        } catch {
          // Skip bodies that aren't valid JSON.
        }
      }
    },
  };
}

/** Serialize one JSON-RPC message with its Content-Length header. */
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

// --- JSON-RPC client ------------------------------------------------------------------

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: unknown;
}

export interface StdioClientOptions {
  command: string;
  args?: string[];
  /** Workspace root (the worktree). Becomes rootUri in initialize. */
  rootDir: string;
  /** Per-request timeout; default 15s. */
  requestTimeoutMs?: number;
  /** Extra initializationOptions for the server. */
  initializationOptions?: unknown;
}

export class RequestTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`LSP request ${method} timed out after ${ms}ms`);
    this.name = "RequestTimeoutError";
  }
}

/**
 * A running LSP server over stdio. Create with `startStdioClient` (which
 * performs spawn + initialize/initialized).
 */
export class StdioClient {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notificationHandlers = new Map<string, (params: unknown) => void>();
  private requestTimeoutMs: number;
  private exited = false;

  constructor(child: ChildProcess, requestTimeoutMs: number) {
    this.child = child;
    this.requestTimeoutMs = requestTimeoutMs;

    const parser = createFrameParser((msg) => this.dispatch(msg));
    child.stdout?.on("data", (c: Buffer) => parser.push(c));
    child.on("exit", () => {
      this.exited = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("LSP server exited"));
      }
      this.pending.clear();
    });
    // Never let a spawn/pipe error crash the host process.
    child.on("error", () => {
      this.exited = true;
    });
    child.stdin?.on("error", () => {});
  }

  get alive(): boolean {
    return !this.exited;
  }

  private dispatch(msg: unknown): void {
    const m = msg as JsonRpcResponse;
    if (m.id !== undefined && m.method === undefined) {
      const pending = this.pending.get(Number(m.id));
      if (!pending) return;
      this.pending.delete(Number(m.id));
      clearTimeout(pending.timer);
      if (m.error) pending.reject(new Error(m.error.message));
      else pending.resolve(m.result);
      return;
    }
    if (m.method !== undefined && m.id !== undefined) {
      // Server→client request (e.g. workspace/configuration): answer null so
      // the server doesn't stall waiting on us.
      this.send({ jsonrpc: "2.0", id: m.id, result: null });
      return;
    }
    if (m.method !== undefined) {
      this.notificationHandlers.get(m.method)?.(m.params);
    }
  }

  private send(message: unknown): void {
    if (this.exited) return;
    try {
      this.child.stdin?.write(encodeFrame(message));
    } catch {
      /* broken pipe — exit handler cleans up */
    }
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    if (this.exited) return Promise.reject(new Error("LSP server exited"));
    const id = this.nextId++;
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RequestTimeoutError(method, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => resolvePromise(v as T),
        reject,
        timer,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** shutdown → exit → kill, each with a short grace period. */
  async stop(): Promise<void> {
    if (!this.exited) {
      try {
        await this.request("shutdown", null, 2000);
      } catch {
        /* proceed to exit/kill */
      }
      try {
        this.notify("exit", null);
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!this.exited) {
      this.child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 700));
    }
    if (!this.exited) this.child.kill("SIGKILL");
  }
}

/** Spawn the server and run the initialize/initialized handshake. */
export async function startStdioClient(
  opts: StdioClientOptions,
): Promise<StdioClient> {
  const child = spawn(opts.command, opts.args ?? [], {
    cwd: opts.rootDir,
    stdio: ["pipe", "pipe", "ignore"],
  });

  await new Promise<void>((resolveSpawn, reject) => {
    child.once("spawn", () => resolveSpawn());
    child.once("error", (err) => reject(err));
  });

  const client = new StdioClient(child, opts.requestTimeoutMs ?? 15_000);

  await client.request(
    "initialize",
    {
      processId: process.pid,
      rootUri: pathToFileURL(resolve(opts.rootDir)).href,
      workspaceFolders: [
        {
          uri: pathToFileURL(resolve(opts.rootDir)).href,
          name: "sleek-worktree",
        },
      ],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          publishDiagnostics: {},
          definition: {},
        },
      },
      initializationOptions: opts.initializationOptions,
    },
    30_000, // handshake gets a generous budget; rust-analyzer replies fast then indexes
  );
  client.notify("initialized", {});
  return client;
}

// --- LSP wire ↔ Sleek types conversion --------------------------------------------------

interface LspPosition {
  line: number;
  character: number;
}
interface LspWireRange {
  start: LspPosition;
  end: LspPosition;
}
interface LspLocation {
  uri: string;
  range: LspWireRange;
}
interface LspLocationLink {
  targetUri: string;
  targetRange: LspWireRange;
  targetSelectionRange?: LspWireRange;
}
interface LspDiagnostic {
  range: LspWireRange;
  severity?: number;
  message: string;
  source?: string;
}
interface LspHover {
  contents:
    | string
    | { kind?: string; value: string }
    | { language: string; value: string }
    | Array<string | { language: string; value: string }>;
  range?: LspWireRange;
}

function fromWireRange(r: LspWireRange): {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
} {
  return {
    startLine: r.start.line + 1,
    startCol: r.start.character + 1,
    endLine: r.end.line + 1,
    endCol: r.end.character + 1,
  };
}

function hoverContentsToMarkdown(contents: LspHover["contents"]): string {
  const one = (
    c: string | { kind?: string; value: string } | { language: string; value: string },
  ): string => {
    if (typeof c === "string") return c;
    if ("language" in c && c.language) {
      return "```" + c.language + "\n" + c.value + "\n```";
    }
    return c.value;
  };
  if (Array.isArray(contents)) return contents.map(one).filter(Boolean).join("\n\n");
  return one(contents);
}

const WIRE_SEVERITY: Record<number, Diag["severity"]> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

// --- Provider over a stdio server -------------------------------------------------------

export interface StdioProviderOptions {
  /** Binary name on PATH, e.g. "rust-analyzer". */
  command: string;
  args?: string[];
  /** Args used for the availability probe; default ["--version"]. */
  versionArgs?: string[];
  /** File extensions handled, e.g. ["rs"]. */
  languages: string[];
  /** LSP languageId for didOpen, e.g. "rust". */
  languageId: string;
  /** Worktree root — the workspace the server is started in. */
  worktreeRoot: string;
  /** Shown when the binary is missing. */
  installHint: string;
  /** Diagnostics source tag; defaults to `command`. */
  source?: string;
  requestTimeoutMs?: number;
  diagnosticsTimeoutMs?: number;
  initializationOptions?: unknown;
}

/** Probe a binary via `<command> <versionArgs>` with a 5s timeout. Cached by callers. */
export function probeBinary(
  command: string,
  versionArgs: string[] = ["--version"],
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    try {
      const child = execFile(
        command,
        versionArgs,
        { timeout: 5000 },
        (err) => resolvePromise(!err),
      );
      child.on("error", () => resolvePromise(false));
    } catch {
      resolvePromise(false);
    }
  });
}

/**
 * Build a LangProvider around an external stdio LSP server. Lazy: nothing is
 * probed or spawned until ready()/first query. A missing binary leaves the
 * provider in "unavailable" (with installHint); a request timeout marks it
 * "warming" and returns null/[].
 */
export function createStdioProvider(opts: StdioProviderOptions): LangProvider {
  const root = resolve(opts.worktreeRoot);
  const requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
  const diagnosticsTimeoutMs = opts.diagnosticsTimeoutMs ?? 10_000;
  const source = opts.source ?? opts.command;

  let state: ProviderState = "off";
  let client: StdioClient | null = null;
  let starting: Promise<void> | null = null;
  let detected: Promise<boolean> | null = null;

  const openUris = new Set<string>();
  /** Latest publishDiagnostics per uri. */
  const diagnosticsByUri = new Map<string, Diag[]>();
  /** First-publish waiters per uri. */
  const diagnosticsWaiters = new Map<string, Array<(d: Diag[]) => void>>();

  function absPath(file: string): string {
    return isAbsolute(file) ? resolve(file) : resolve(root, file);
  }

  function toRelative(absFile: string): string {
    const rel = relative(root, absFile);
    return rel.startsWith("..") || isAbsolute(rel)
      ? absFile
      : rel.split(sep).join("/");
  }

  function detect(): Promise<boolean> {
    detected ??= probeBinary(opts.command, opts.versionArgs);
    return detected;
  }

  async function start(): Promise<void> {
    if (state === "unavailable") return;
    if (client?.alive) return;
    starting ??= (async () => {
      state = "starting";
      if (!(await detect())) {
        state = "unavailable";
        return;
      }
      try {
        client = await startStdioClient({
          command: opts.command,
          args: opts.args,
          rootDir: root,
          requestTimeoutMs,
          initializationOptions: opts.initializationOptions,
        });
        client.onNotification("textDocument/publishDiagnostics", (params) => {
          const p = params as { uri: string; diagnostics: LspDiagnostic[] };
          if (!p?.uri) return;
          const diags: Diag[] = (p.diagnostics ?? []).map((d) => ({
            ...fromWireRange(d.range),
            severity: WIRE_SEVERITY[d.severity ?? 1] ?? "error",
            message: d.message,
            source: d.source ?? source,
          }));
          diagnosticsByUri.set(p.uri, diags);
          const waiters = diagnosticsWaiters.get(p.uri);
          if (waiters) {
            diagnosticsWaiters.delete(p.uri);
            for (const w of waiters) w(diags);
          }
        });
        state = "ready";
      } catch {
        state = "unavailable";
        client = null;
      }
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  /** didOpen the file (once) so the server has its content; returns its uri. */
  function ensureOpen(absFile: string): string | null {
    const uri = pathToFileURL(absFile).href;
    if (openUris.has(uri)) return uri;
    let text: string;
    try {
      text = readFileSync(absFile, "utf8");
    } catch {
      return null;
    }
    client?.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: opts.languageId,
        version: 1,
        text,
      },
    });
    openUris.add(uri);
    return uri;
  }

  function onTimeout(err: unknown): void {
    if (err instanceof RequestTimeoutError) state = "warming";
  }

  return {
    languages: opts.languages,
    installHint: opts.installHint,
    state: () => state,
    detect,

    async ready(): Promise<void> {
      await start();
    },

    async hover(file, line, character): Promise<HoverResult | null> {
      try {
        await start();
        if (!client?.alive) return null;
        const uri = ensureOpen(absPath(file));
        if (!uri) return null;
        const result = await client.request<LspHover | null>(
          "textDocument/hover",
          {
            textDocument: { uri },
            position: { line: line - 1, character: character - 1 },
          },
        );
        if (state === "warming") state = "ready";
        if (!result) return null;
        const contents = hoverContentsToMarkdown(result.contents);
        if (!contents.trim()) return null;
        return {
          contents,
          range: result.range ? fromWireRange(result.range) : undefined,
        };
      } catch (err) {
        onTimeout(err);
        return null;
      }
    },

    async definition(file, line, character): Promise<DefResult[]> {
      try {
        await start();
        if (!client?.alive) return [];
        const uri = ensureOpen(absPath(file));
        if (!uri) return [];
        const result = await client.request<
          LspLocation | LspLocation[] | LspLocationLink[] | null
        >("textDocument/definition", {
          textDocument: { uri },
          position: { line: line - 1, character: character - 1 },
        });
        if (state === "warming") state = "ready";
        if (!result) return [];
        const locations = Array.isArray(result) ? result : [result];

        const out: DefResult[] = [];
        for (const loc of locations) {
          const targetUri =
            "targetUri" in loc ? loc.targetUri : (loc as LspLocation).uri;
          const wireRange =
            "targetUri" in loc
              ? (loc.targetSelectionRange ?? loc.targetRange)
              : (loc as LspLocation).range;
          if (!targetUri || !wireRange) continue;
          let targetPath: string;
          try {
            targetPath = fileURLToPath(targetUri);
          } catch {
            continue;
          }
          const range = fromWireRange(wireRange);
          let preview: string | undefined;
          try {
            preview = readFileSync(targetPath, "utf8")
              .split("\n")
              [range.startLine - 1]?.trim();
          } catch {
            preview = undefined;
          }
          out.push({ file: toRelative(targetPath), ...range, preview });
        }
        return out;
      } catch (err) {
        onTimeout(err);
        return [];
      }
    },

    async diagnostics(file): Promise<Diag[]> {
      try {
        await start();
        if (!client?.alive) return [];
        const abs = absPath(file);
        const alreadyOpen = openUris.has(pathToFileURL(abs).href);
        const uri = ensureOpen(abs);
        if (!uri) return [];
        // Already have a publish for this uri → serve the latest.
        const existing = diagnosticsByUri.get(uri);
        if (existing && alreadyOpen) return existing;
        // Wait for the first publishDiagnostics for this uri, else [].
        return await new Promise<Diag[]>((resolvePromise) => {
          const timer = setTimeout(() => {
            const waiters = diagnosticsWaiters.get(uri) ?? [];
            diagnosticsWaiters.set(
              uri,
              waiters.filter((w) => w !== onPublish),
            );
            state = "warming";
            resolvePromise(diagnosticsByUri.get(uri) ?? []);
          }, diagnosticsTimeoutMs);
          timer.unref?.();
          const onPublish = (d: Diag[]) => {
            clearTimeout(timer);
            if (state === "warming") state = "ready";
            resolvePromise(d);
          };
          const waiters = diagnosticsWaiters.get(uri) ?? [];
          waiters.push(onPublish);
          diagnosticsWaiters.set(uri, waiters);
        });
      } catch {
        return [];
      }
    },

    async dispose(): Promise<void> {
      const c = client;
      client = null;
      state = "off";
      openUris.clear();
      diagnosticsByUri.clear();
      diagnosticsWaiters.clear();
      if (c) await c.stop();
    },
  };
}
