/**
 * Minimal local server for a Sleek review: serves the rendered review HTML and
 * exposes the Assistant (POST /api/ask, streaming), Escalation
 * (POST /api/escalate, streaming) and expandable diff context
 * (POST /api/context, JSON) over plain node:http — no framework.
 *
 * Same-origin only (the UI is served from GET /), so no CORS handling.
 *
 * Runners are injectable via opts so tests exercise routing/streaming without
 * Ollama or an Anthropic key; defaults are the real Ollama/Anthropic runners.
 */

import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, resolve, sep } from "node:path";

/** Sentinel thrown by readBody when the incoming body exceeds MAX_BODY_BYTES. */
class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
  }
}

import type { Anchor, ReviewScaffold, Layer } from "../domain/scaffold.ts";

/**
 * Progress event streamed by POST /api/scaffold as NDJSON. Mirrors the scaffold()
 * phase callbacks but wrapped in an HTTP-friendly envelope with an `event` discriminant.
 * Exported so 7B (scripts) can supply a conforming `scaffolding.run()` closure.
 */
export type ScaffoldProgressEvent =
  | {
      event: "stage";
      stage: "ingest" | "skeleton" | "detail" | "stats";
      status: "start" | "done" | "progress";
      done?: number;
      total?: number;
      layers?: number;
      findings?: number;
      ms?: number;
      note?: string;
      files?: number;
      regions?: number;
      bytes?: number;
      noiseFiles?: number;
    }
  | { event: "plan"; planLayers: Array<{ id: string; title: string; regionCount: number; files: string[] }>; stackedOnto?: string | null }
  | { event: "partial-scaffold"; layers: Array<{ id: string; title: string; order: number; anchors: Array<{ file: string; side: "LEFT" | "RIGHT"; startLine: number; endLine: number }> }> }
  | { event: "detail"; layer: string; status: "start" | "done" | "retry"; ms?: number; findings?: number }
  | { event: "activity"; layer?: string; text: string }
  | { event: "done"; layers: number; findings: number }
  | { event: "error"; message: string };
import { AnchorSchema } from "../domain/scaffold.ts";
import { diffScaffolds } from "../domain/scaffolddiff.ts";
import { ReviewVerdictSchema } from "../domain/threads.ts";
import type { Comment, CommentAuthor, Thread } from "../domain/threads.ts";
import type { Store } from "../store/store.ts";
import { layerForSelection } from "../assistant/resolve.ts";
import { buildAssistantMessages } from "../assistant/prompt.ts";
import {
  askAssistant,
  createOllamaRunner,
  DEFAULT_LOCAL_MODEL,
} from "../assistant/assistant.ts";
import type { LocalRunner } from "../assistant/assistant.ts";
import {
  askOpus,
  createDefaultCloudRunner,
  isEscalationAvailable,
} from "../assistant/escalate.ts";
import type { CloudRunner } from "../assistant/escalate.ts";
import type { LspManager } from "../lsp/manager.ts";
import type { GhRunner } from "../ingest/ingest.ts";
import { buildReviewExport } from "../export/github.ts";
import {
  emptyPublishedConversation,
  normalizeGithubIssueComments,
  normalizeGithubReviewComments,
  normalizeGithubReviews,
  type PublishedConversationSnapshot,
} from "../domain/published.ts";
import type { BlameInfo } from "./blame.ts";
export type { BlameInfo } from "./blame.ts";
import type { DiffFile } from "../render/diffmodel.ts";
import { renderFileRowsHtml } from "../render/html.ts";
import { wsOnlyRows } from "../render/whitespace.ts";
import { listScaffolderChoices, parseScaffolderChoice } from "../scaffolder/runners.ts";
import { ScaffoldJob } from "./scaffoldjob.ts";
import type { LoggedEvent, Subscriber } from "./scaffoldjob.ts";

const OLLAMA_HOST = "http://localhost:11434";

/**
 * Everything POST /api/review/export needs to post the submitted Review to the
 * real GitHub PR (Wave 4A). `gh` must be the RAW runner (defaultGhRunner), not
 * the caching wrapper — a review POST must never be served from or written to
 * the cache. When absent, export runs dry-run only and /api/health reports
 * githubExport:false so the UI hides the option.
 */
export interface GithubExportOptions {
  owner: string;
  repo: string;
  /** Raw gh runner; invoked with the JSON payload on stdin (`--input -`). */
  gh: GhRunner;
  /** Working directory gh runs in (the Reviewer's repo clone). */
  repoPath: string;
}

export interface ServerActions {
  blame?: (req: {
    file: string;
    side: "LEFT" | "RIGHT";
    line: number;
  }) => Promise<BlameInfo | null>;
  openSource?: (file: string, line: number) => Promise<boolean>;
}

export interface StartServerOptions {
  /** The rendered review page, served at GET /. */
  html: string;
  /** The Review Scaffold questions are resolved against. */
  scaffold: ReviewScaffold;
  /** PR title, passed into the Assistant prompt. */
  prTitle: string;
  /** Port to listen on; 0/undefined → ephemeral. */
  port?: number;
  /**
   * Host to bind on; defaults to "127.0.0.1" so the server is loopback-only.
   * Pass "0.0.0.0" only when intentionally exposing the server on the network.
   */
  host?: string;
  /** Explicit Ollama model; overrides env + tag discovery. */
  ollamaModel?: string;
  /** Injectable for tests; defaults to the real Ollama runner. */
  localRunner?: LocalRunner;
  /** Injectable for tests; defaults to the real Anthropic runner. */
  cloudRunner?: CloudRunner;
  /**
   * Optional language-intelligence manager (Wave LSP). When absent, the
   * /api/lsp/* routes 404 and /api/health omits the `lsp` key. Compose one
   * with createWorktreeLsp(repoPath, headSha) from src/lsp/manager.ts.
   */
  lsp?: LspManager;
  /**
   * Worktree root for the LSP routes' path-containment guard. When present,
   * /api/lsp/* 400s when the `file` param is absolute or resolves outside
   * this directory (lexical check, same guard as contextReader). When absent
   * the guard only rejects absolute paths.
   */
  lspWorktree?: string;
  /**
   * Optional persistence for the Wave-2 thread model (threads, comments,
   * reviews). When absent, the /api/threads* and /api/review* routes 404 with
   * {error:"threads unavailable"} and /api/health reports threads:false.
   * When present, Finding threads are seeded on startup (idempotent) and the
   * routes are keyed by the scaffold's PR number + head SHA.
   */
  store?: Store;
  /**
   * Optional reader for POST /api/context (expandable diff context): given a
   * RIGHT-side (head-SHA) worktree-relative file path, return the FULL file
   * text, or null when the file is unreadable or escapes the worktree. When
   * absent, /api/context 404s and /api/health reports context:false. Compose
   * the real one with createFileContextReader(worktreePath).
   */
  contextReader?: (file: string) => string | null;
  /**
   * Optional GitHub export target (Wave 4A). When present alongside a store,
   * POST /api/review/export can post the submitted Review to the real PR via
   * `gh api`; when absent the endpoint answers dry-run only with
   * available:false and /api/health reports githubExport:false.
   */
  github?: GithubExportOptions;
  /** Optional code actions for live diff-row context menus. */
  actions?: ServerActions;
  /**
   * Parsed diff files for GET /api/filerows (lazy large-file hydration). When
   * present, the route re-renders the requested file's rows on demand so the
   * initial page can omit them (lazyLargeFiles mode in renderReviewHtml). When
   * absent, GET /api/filerows → 404 and the client falls back to the embedded
   * (non-lazy) behavior.
   */
  diffFiles?: DiffFile[];

  /**
   * Optional Wave-7 scaffolding capability. When present, POST /api/scaffold
   * streams a live scaffold run. When absent, POST /api/scaffold → 503.
   * The closure owns ingest artifacts and re-render logic so serve.ts stays
   * render-free.
   */
  scaffolding?: {
    /** True when live scaffolding is possible. Field name is frozen for clients. */
    anthropic: boolean;
    /** Human-readable label for the active scaffolder provider (e.g. "Anthropic API", "Claude Code CLI"). */
    providerLabel?: string;
    /** True when an authored replay JSON exists for this PR. */
    replay: boolean;
    /**
     * Run a scaffold with the given choice, calling onEvent for each progress
     * event. Returns the new scaffold + rendered HTML.
     * The optional third arg carries an AbortSignal so the closure can stop
     * work early when the client disconnects (integrator may ignore it).
     */
    run(
      choice: { kind: "replay" } | { kind: "cli"; provider: "claude" | "codex"; model?: string },
      onEvent: (e: ScaffoldProgressEvent) => void,
      opts?: {
        signal?: AbortSignal;
        /**
         * Wave-3A: called when skeleton phase completes with a partial scaffold
         * (layers with anchors, empty bundles/findings) + partial HTML. Lets the
         * server swap currentHtml so a browser refresh shows the skeleton review
         * instead of the empty-scaffold placeholder.
         */
        onPartialResult?: (result: { scaffold: ReviewScaffold; html: string }) => void;
      },
    ): Promise<{ scaffold: ReviewScaffold; html: string }>;
  };

  /** Optional live-session finish action. When present, POST /api/finish is enabled. */
  finish?: {
    available: boolean;
    run(): Promise<void>;
  };
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Body accepted by the POST /api/lsp/* routes. `line`/`character` are
 * 1-based (see src/lsp/types.ts); `file` is worktree-relative.
 */
interface LspBody {
  file?: string;
  line?: number;
  character?: number;
}

/** Body accepted by POST /api/ask and POST /api/escalate. */
interface AskBody {
  question: string;
  layerId?: string | null;
  file?: string;
  side?: "LEFT" | "RIGHT";
  startLine?: number;
  endLine?: number;
  selectedText?: string;
}

/**
 * Resolve the local model at startup: explicit option, else SLEEK_OLLAMA_MODEL,
 * else ask Ollama for its tags and prefer one containing "instruct" or
 * "qwen3", else the first tag. Falls back to DEFAULT_LOCAL_MODEL (with a
 * warning) when Ollama is unreachable or has no models.
 */
export async function resolveOllamaModel(explicit?: string): Promise<string> {
  let model: string | undefined = explicit ?? process.env.SLEEK_OLLAMA_MODEL;

  if (!model) {
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/tags`);
      if (!res.ok) throw new Error(`GET /api/tags → ${res.status}`);
      const data = (await res.json()) as { models?: { name: string }[] };
      const names = (data.models ?? []).map((m) => m.name);
      model =
        names.find((n) => n.toLowerCase().includes("instruct")) ??
        names.find((n) => n.toLowerCase().includes("qwen3")) ??
        names[0];
      if (!model) {
        console.warn(
          `[sleek] Ollama at ${OLLAMA_HOST} reports no models; ` +
            `falling back to ${DEFAULT_LOCAL_MODEL}. Run \`ollama pull <model>\`.`,
        );
        model = DEFAULT_LOCAL_MODEL;
      }
    } catch {
      console.warn(
        `[sleek] Could not reach Ollama at ${OLLAMA_HOST} to list models; ` +
          `falling back to ${DEFAULT_LOCAL_MODEL}. Is \`ollama serve\` running?`,
      );
      model = DEFAULT_LOCAL_MODEL;
    }
  }

  if (model.toLowerCase().includes("base")) {
    console.warn(
      `[sleek] WARNING: selected Ollama model "${model}" looks like a BASE ` +
        `model — base models follow instructions poorly. Prefer an instruct ` +
        `tune (set SLEEK_OLLAMA_MODEL to override).`,
    );
  }
  return model;
}

/**
 * DNS-rebinding / CSRF guard: the server binds loopback, but a malicious page
 * can point its own hostname at 127.0.0.1 and make the browser send requests
 * that reach us with an attacker-controlled Host header. Only accept Hosts
 * that name loopback itself, with the bound port (or no port at all).
 *
 * Exported for unit testing.
 */
export function isAllowedHost(
  hostHeader: string | undefined,
  boundPort: number,
): boolean {
  if (!hostHeader) return false;
  let hostname: string;
  let portPart: string | null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostHeader);
  if (bracketed) {
    // IPv6 literal, e.g. "[::1]:3000"
    hostname = bracketed[1]!;
    portPart = bracketed[2] ?? null;
  } else {
    const colon = hostHeader.lastIndexOf(":");
    hostname = colon === -1 ? hostHeader : hostHeader.slice(0, colon);
    portPart = colon === -1 ? null : hostHeader.slice(colon + 1);
  }
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
    return false;
  }
  return portPart === null || portPart === String(boundPort);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const MAX_BODY_BYTES = 1_048_576; // 1 MiB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when the error smells like a refused local connection (Ollama down). */
function looksUnreachable(err: unknown): boolean {
  const m = errorMessage(err).toLowerCase();
  return (
    m.includes("econnrefused") ||
    m.includes("fetch failed") ||
    m.includes("unable to connect") ||
    m.includes("socket") ||
    m.includes("network")
  );
}

/** Resolve the owning Layer: explicit layerId wins, else selection overlap. */
function resolveLayer(scaffold: ReviewScaffold, body: AskBody): Layer | null {
  if (body.layerId) {
    return scaffold.layers.find((l) => l.id === body.layerId) ?? null;
  }
  if (
    body.file &&
    (body.side === "LEFT" || body.side === "RIGHT") &&
    typeof body.startLine === "number" &&
    typeof body.endLine === "number"
  ) {
    return layerForSelection(
      scaffold,
      body.file,
      body.side,
      body.startLine,
      body.endLine,
    );
  }
  return null;
}

function lineLabel(body: AskBody): string | undefined {
  if (
    (body.side === "LEFT" || body.side === "RIGHT") &&
    typeof body.startLine === "number" &&
    typeof body.endLine === "number"
  ) {
    return `[${body.side}] lines ${body.startLine}-${body.endLine}`;
  }
  return undefined;
}

function parseVisibility(value: unknown): "local" | "publishable" | undefined {
  return value === "local" || value === "publishable" ? value : undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

// ── EventStream helper ────────────────────────────────────────────────────────

interface EventStream {
  writeHead(contentType: string): void;
  write(text: string): boolean;
  writeJson(obj: unknown): void;
  end(): void;
  readonly aborted: boolean;
  readonly signal: AbortSignal;
  onAbort(cb: () => void): void;
}

const SOCKET_ERROR_CODES = new Set([
  "EPIPE",
  "ECONNRESET",
  "ERR_STREAM_WRITE_AFTER_END",
]);

function createEventStream(req: IncomingMessage, res: ServerResponse): EventStream {
  const controller = new AbortController();
  let _aborted = false;
  let _headSent = false;

  function markAborted(): void {
    if (_aborted) return;
    _aborted = true;
    controller.abort();
  }

  function swallow(err: unknown): void {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && SOCKET_ERROR_CODES.has(code)) {
      markAborted();
    } else {
      console.warn("[EventStream] socket error:", err);
      markAborted();
    }
  }

  res.on("error", swallow);

  req.on("close", () => {
    if (!res.writableEnded) markAborted();
  });
  res.on("close", () => {
    if (!res.writableEnded) markAborted();
  });

  const stream: EventStream = {
    writeHead(contentType: string): void {
      if (_headSent) return;
      _headSent = true;
      res.writeHead(200, {
        "content-type": contentType,
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      });
      res.flushHeaders();
    },

    write(text: string): boolean {
      if (_aborted || res.writableEnded || res.destroyed) return false;
      try {
        return res.write(text) as boolean;
      } catch (err) {
        swallow(err);
        return false;
      }
    },

    writeJson(obj: unknown): void {
      stream.write(JSON.stringify(obj) + "\n");
    },

    end(): void {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.end();
      } catch {
        // already closed
      }
    },

    get aborted(): boolean {
      return _aborted;
    },

    get signal(): AbortSignal {
      return controller.signal;
    },

    onAbort(cb: () => void): void {
      controller.signal.addEventListener("abort", cb, { once: true });
    },
  };

  return stream;
}

// ── Module-level guard: absorb socket-level uncaught exceptions once ──────────
let _uncaughtSocketGuardInstalled = false;
function ensureUncaughtSocketGuard(): void {
  if (_uncaughtSocketGuardInstalled) return;
  _uncaughtSocketGuardInstalled = true;
  process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
    const code = err.code ?? "";
    if (SOCKET_ERROR_CODES.has(code)) return;
    throw err;
  });
}

/**
 * Stream `chunks` to `res` as chunked text/plain. Pulls the FIRST chunk before
 * flushing headers so a runner that fails immediately (e.g. Ollama down)
 * still gets a proper JSON error status; after headers are out, a mid-stream
 * error is appended as a text marker.
 */
async function streamAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  chunks: AsyncIterable<string>,
  unreachableHint: string,
): Promise<void> {
  const iterator = chunks[Symbol.asyncIterator]();
  let first: IteratorResult<string>;
  try {
    first = await iterator.next();
  } catch (err) {
    const status = looksUnreachable(err) ? 502 : 500;
    const hint = status === 502 ? " " + unreachableHint : "";
    sendJson(res, status, { error: (errorMessage(err) + "." + hint).trim() });
    return;
  }

  const stream = createEventStream(req, res);
  stream.writeHead("text/plain; charset=utf-8");

  try {
    while (!first.done) {
      if (stream.aborted) break;
      stream.write(first.value);
      if (stream.aborted) break;
      first = await iterator.next();
    }
  } catch (err) {
    stream.write("\n[stream error: " + errorMessage(err) + "]");
  }
  stream.end();
}

/**
 * The /api/lsp/* routes (Wave LSP). All JSON. 404 when no LspManager is
 * wired in; 200 {available:false, installHint} when the file's language has
 * no working provider (binary missing / extension unknown). Coordinates are
 * 1-based lines/columns, files worktree-relative.
 */
async function handleLspRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  lsp: LspManager | undefined,
  lspWorktree?: string,
): Promise<void> {
  if (!lsp) {
    sendJson(res, 404, { error: "LSP not enabled for this session" });
    return;
  }

  if (route === "GET /api/lsp/status") {
    sendJson(res, 200, await lsp.status());
    return;
  }

  const needsPosition =
    route === "POST /api/lsp/hover" || route === "POST /api/lsp/definition";
  if (needsPosition || route === "POST /api/lsp/diagnostics") {
    let body: LspBody;
    try {
      body = JSON.parse(await readBody(req)) as LspBody;
    } catch (err) {
      if (err instanceof BodyTooLargeError) throw err;
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (typeof body.file !== "string" || body.file === "") {
      sendJson(res, 400, { error: "`file` (string) is required" });
      return;
    }
    // Path-containment guard: reject absolute paths and traversals outside the worktree.
    if (isAbsolute(body.file)) {
      sendJson(res, 400, { error: "`file` must be a worktree-relative path, not absolute" });
      return;
    }
    if (lspWorktree !== undefined) {
      const wt = resolve(lspWorktree);
      const abs = resolve(wt, body.file);
      if (!abs.startsWith(wt + sep)) {
        sendJson(res, 400, { error: "`file` escapes the worktree" });
        return;
      }
    }
    if (
      needsPosition &&
      (typeof body.line !== "number" || typeof body.character !== "number")
    ) {
      sendJson(res, 400, {
        error: "`line` and `character` (1-based numbers) are required",
      });
      return;
    }

    const availability = await lsp.availability(body.file);
    if (!availability.available) {
      sendJson(res, 200, {
        available: false,
        ...(availability.installHint
          ? { installHint: availability.installHint }
          : {}),
      });
      return;
    }

    if (route === "POST /api/lsp/hover") {
      const hover = await lsp.hover(body.file, body.line!, body.character!);
      sendJson(res, 200, { available: true, hover });
    } else if (route === "POST /api/lsp/definition") {
      const definitions = await lsp.definition(
        body.file,
        body.line!,
        body.character!,
      );
      sendJson(res, 200, { available: true, definitions });
    } else {
      const diagnostics = await lsp.diagnostics(body.file);
      sendJson(res, 200, { available: true, diagnostics });
    }
    return;
  }

  sendJson(res, 404, { error: `no route: ${route}` });
}

// ── Expandable context route ─────────────────────────────────────────────────────────

/**
 * Body accepted by POST /api/context. `startLine`/`endLine` are RIGHT-side
 * (new-file, head-SHA) 1-based line numbers, inclusive; `file` is
 * worktree-relative.
 */
interface ContextBody {
  file?: unknown;
  startLine?: unknown;
  endLine?: unknown;
}

interface OpenSourceBody {
  file?: unknown;
  line?: unknown;
}

/** Max lines POST /api/context returns per request (larger ranges are clamped). */
const MAX_CONTEXT_LINES = 200;

/**
 * Build the real contextReader for StartServerOptions from the PR-head
 * worktree root: reads `file` (worktree-relative) and returns its full text.
 * Guards against path traversal — a resolved path escaping `rootDir` returns
 * null (→ 404), as does any read failure.
 */
export function createFileContextReader(
  rootDir: string,
): (file: string) => string | null {
  const root = resolve(rootDir);
  // Resolve the root itself through symlinks once at construction time.
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }
  return (file) => {
    const abs = resolve(root, file);
    if (!abs.startsWith(root + sep)) return null;
    // Symlink re-check: resolve the real path and verify it still sits under root.
    let realAbs: string;
    try {
      realAbs = realpathSync(abs);
    } catch {
      // File doesn't exist or can't be resolved; fall through to readFileSync
      // which will also fail and return null.
      realAbs = abs;
    }
    if (!realAbs.startsWith(realRoot + sep)) return null;
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  };
}

/**
 * POST /api/context (expandable diff context). Responds with the requested
 * head-SHA lines as {lines:[{line, text}]} — context rows are identical on
 * both sides, so the client derives LEFT numbering from hunk offsets.
 *
 * 404 when no contextReader is wired in or the file is unreadable/escapes the
 * worktree; 400 for a malformed range. The range is CLAMPED (not rejected):
 * ends past EOF return what exists (a fully out-of-range request yields
 * {lines: []}), and ranges longer than MAX_CONTEXT_LINES are truncated to the
 * first MAX_CONTEXT_LINES lines.
 */
async function handleContextRoute(
  req: IncomingMessage,
  res: ServerResponse,
  contextReader: ((file: string) => string | null) | undefined,
): Promise<void> {
  if (!contextReader) {
    sendJson(res, 404, { error: "context not enabled for this session" });
    return;
  }

  let body: ContextBody;
  try {
    body = JSON.parse(await readBody(req)) as ContextBody;
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw err;
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  if (typeof body.file !== "string" || body.file === "") {
    sendJson(res, 400, { error: "`file` (string) is required" });
    return;
  }
  const { startLine, endLine } = body;
  if (
    typeof startLine !== "number" ||
    typeof endLine !== "number" ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    sendJson(res, 400, {
      error:
        "`startLine` and `endLine` must be 1-based integers with startLine <= endLine",
    });
    return;
  }

  const text = contextReader(body.file);
  if (text === null) {
    sendJson(res, 404, { error: `cannot read file: ${body.file}` });
    return;
  }

  const fileLines = text.split("\n");
  // A trailing newline terminates the last line; it doesn't start a new one.
  if (fileLines.length > 0 && fileLines[fileLines.length - 1] === "") {
    fileLines.pop();
  }

  const last = Math.min(
    endLine,
    fileLines.length,
    startLine + MAX_CONTEXT_LINES - 1,
  );
  const lines: { line: number; text: string }[] = [];
  for (let line = startLine; line <= last; line++) {
    lines.push({ line, text: fileLines[line - 1]! });
  }
  sendJson(res, 200, { lines });
}

async function handleBlameRoute(
  res: ServerResponse,
  url: URL,
  actions: ServerActions | undefined,
): Promise<void> {
  const file = url.searchParams.get("file");
  const side = url.searchParams.get("side");
  const lineRaw = url.searchParams.get("line");
  const line = lineRaw === null ? NaN : Number(lineRaw);

  if (
    !file ||
    (side !== "LEFT" && side !== "RIGHT") ||
    !Number.isInteger(line) ||
    line < 1
  ) {
    sendJson(res, 400, { error: "bad blame params" });
    return;
  }
  if (!actions?.blame) {
    sendJson(res, 503, { error: "blame not available" });
    return;
  }

  let blame: BlameInfo | null;
  try {
    blame = await actions.blame({ file, side, line });
  } catch {
    blame = null;
  }
  if (!blame) {
    sendJson(res, 404, { error: "no blame" });
    return;
  }
  sendJson(res, 200, blame);
}

async function handleOpenSourceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  actions: ServerActions | undefined,
): Promise<void> {
  let body: OpenSourceBody;
  try {
    body = JSON.parse(await readBody(req)) as OpenSourceBody;
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw err;
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  if (typeof body.file !== "string" || body.file === "" || !isPositiveInteger(body.line)) {
    sendJson(res, 400, { error: "`file` (string) and `line` (positive integer) are required" });
    return;
  }
  if (!actions?.openSource) {
    sendJson(res, 503, { error: "open not available" });
    return;
  }

  try {
    if (await actions.openSource(body.file, body.line)) {
      sendJson(res, 200, { ok: true });
      return;
    }
  } catch {
    // fall through to failure response
  }
  sendJson(res, 502, { ok: false });
}

// ── Scaffold-version routes (Wave 4B, versions-lite) ─────────────────────────────────

/**
 * GET /api/versions and GET /api/versions/diff — "Changes since last scaffold".
 * Both require a Store (the caller 404s {error:"versions unavailable"} without
 * one, mirroring the thread routes).
 *
 * GET /api/versions → {versions:[{headSha, createdAt, current}], stale}
 *   Every stored scaffold version for THIS server's PR, newest first (key
 *   columns only — the blobs are never loaded). `current` marks the version
 *   the server is actually serving (opts.scaffold's head SHA; when the served
 *   scaffold was never stored, nothing is marked). `stale` is the store's own
 *   staleness fact (Store.isStale): the NEWEST stored head SHA differs from
 *   the served one — i.e. the store has seen a scaffold this page predates.
 *
 * GET /api/versions/diff?from=<sha> → {fromSha, toSha, diff}
 *   The structural diff (src/domain/scaffolddiff.ts) between the STORED
 *   scaffold at `from` and the SERVED scaffold, computed server-side. The
 *   served side is always opts.scaffold — the page the Reviewer is looking
 *   at — so "what changed" always answers relative to what's on screen.
 *   404 readable-JSON when `from` isn't stored for this PR; 400 when missing.
 */
function handleVersionsRoutes(
  res: ServerResponse,
  route: string,
  url: URL,
  store: Store,
  scaffold: ReviewScaffold,
): void {
  const pr = scaffold.pr.number;
  const servedSha = scaffold.pr.headSha;

  if (route === "GET /api/versions") {
    const versions = store.listScaffoldVersions(pr).map((v) => ({
      headSha: v.headSha,
      createdAt: v.createdAt,
      current: v.headSha === servedSha,
    }));
    sendJson(res, 200, {
      versions,
      stale: store.isStale(pr, servedSha).stale,
    });
    return;
  }

  if (route === "GET /api/versions/diff") {
    const from = url.searchParams.get("from");
    if (!from) {
      sendJson(res, 400, { error: "`from` (a stored head SHA) is required" });
      return;
    }
    const oldScaffold = store.getScaffold(pr, from);
    if (!oldScaffold) {
      sendJson(res, 404, {
        error: `no scaffold stored for PR #${pr} at ${from}`,
      });
      return;
    }
    sendJson(res, 200, {
      fromSha: from,
      toSha: servedSha,
      diff: diffScaffolds(oldScaffold, scaffold),
    });
    return;
  }

  sendJson(res, 404, { error: `no route: ${route}` });
}

// ── Saved-reply routes (Wave 4C) ─────────────────────────────────────────────────────

/**
 * GET/POST /api/replies and DELETE /api/replies/:id — saved replies (the
 * Reviewer's reusable comment templates, GLOBAL — not scoped to this server's
 * PR). All JSON; the caller 404s {error:"replies unavailable"} without a
 * Store, mirroring the thread routes.
 *
 * GET  /api/replies        → {replies:[{id, title, body, createdAt}]}
 * POST /api/replies        {title, body} → 201 the created reply
 * DELETE /api/replies/:id  → {ok:true}; 404 readable-JSON for an unknown id
 */
async function handleRepliesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  store: Store,
): Promise<void> {
  if (route === "GET /api/replies") {
    sendJson(res, 200, { replies: store.listSavedReplies() });
    return;
  }

  if (route === "POST /api/replies") {
    let body: { title?: unknown; body?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch (err) {
      if (err instanceof BodyTooLargeError) throw err;
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (typeof body.title !== "string" || body.title.trim() === "") {
      sendJson(res, 400, { error: "`title` (string) is required" });
      return;
    }
    if (typeof body.body !== "string" || body.body.trim() === "") {
      sendJson(res, 400, { error: "`body` (string) is required" });
      return;
    }
    sendJson(res, 201, store.createSavedReply(body.title.trim(), body.body));
    return;
  }

  const match = /^DELETE \/api\/replies\/(\d+)$/.exec(route);
  if (match) {
    const id = Number(match[1]);
    if (!store.deleteSavedReply(id)) {
      sendJson(res, 404, { error: `no such saved reply: ${id}` });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: `no route: ${route}` });
}

// ── Thread & Review routes (Wave 2) ──────────────────────────────────────────────────

/** Default question for POST /api/threads/:id/ask when none is supplied. */
const DEFAULT_THREAD_QUESTION =
  "Explain this finding and whether it's a real problem.";

/** Everything the thread routes need, bundled once at startup. */
interface ThreadRouteContext {
  store: Store;
  scaffold: ReviewScaffold;
  prTitle: string;
  localRunner: LocalRunner;
  model: string;
  /** GitHub export target; absent → export is dry-run only (available:false). */
  github?: GithubExportOptions;
  /** Shared ref for concurrent-export guard (set true while a real POST is in flight). */
  exportRunningRef: { value: boolean };
}

/** Human-readable speaker label for a Comment, used in the ask transcript. */
function authorLabel(author: CommentAuthor): string {
  switch (author.type) {
    case "finding":
      return "Finding (Scaffolder)";
    case "reviewer":
      return "Reviewer";
    case "assistant":
      return `Assistant (${author.model})`;
  }
}

/** Render a Thread's comments as a plain-text transcript for the Assistant. */
function threadTranscript(thread: Thread): string {
  return thread.comments
    .map((c: Comment) => `${authorLabel(c.author)}:\n${c.body}`)
    .join("\n\n");
}

/**
 * The /api/threads* and /api/review* routes (Wave 2 thread model). All JSON
 * except the streaming ask route. 404 {error:"threads unavailable"} when no
 * Store is wired in (handled by the caller).
 *
 * POST /api/threads/:id/ask streams the Assistant's answer as chunked
 * text/plain (same shape as /api/ask) and, once the stream ends, persists the
 * full answer as a non-pending assistant Comment on the thread. The persisted
 * comment id is deliberately NOT smuggled into the stream (a trailing sentinel
 * would corrupt the visible text for simple clients): the client is expected
 * to REFETCH GET /api/threads after the stream ends to pick up the persisted
 * comment.
 */
async function handleThreadRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  ctx: ThreadRouteContext,
): Promise<void> {
  const { store, scaffold } = ctx;
  const pr = scaffold.pr.number;
  const sha = scaffold.pr.headSha;

  if (route === "GET /api/threads") {
    sendJson(res, 200, {
      threads: store.listThreads(pr, sha),
      review: store.getReview(pr, sha),
      pendingCount: store.pendingComments(pr, sha).length,
      reviewExport: store.getExport(pr, sha),
    });
    return;
  }

  if (route === "GET /api/review") {
    sendJson(res, 200, {
      review: store.getReview(pr, sha),
      pendingCount: store.pendingComments(pr, sha).length,
      reviewExport: store.getExport(pr, sha),
    });
    return;
  }

  if (route === "POST /api/review/submit") {
    let body: { verdict?: unknown; summary?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch (err) {
      if (err instanceof BodyTooLargeError) throw err;
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    const verdict = ReviewVerdictSchema.safeParse(body.verdict);
    if (!verdict.success) {
      sendJson(res, 400, {
        error:
          "`verdict` must be one of: approve, request_changes, comment",
      });
      return;
    }
    const summary = typeof body.summary === "string" ? body.summary : "";
    sendJson(res, 200, store.submitReview(pr, sha, verdict.data, summary));
    return;
  }

  // Wave 4A: post the submitted Review to the real GitHub PR via `gh api`.
  // {dryRun:true} — and any call when no export target is configured — returns
  // the payload + preview WITHOUT touching gh, so the UI's confirmation step is
  // always safe. Only an explicit non-dry-run call with a configured target
  // performs the real POST.
  if (route === "POST /api/review/export") {
    let body: { dryRun?: unknown } = {};
    try {
      const raw = await readBody(req);
      if (raw.trim() !== "") body = JSON.parse(raw) as typeof body;
    } catch (err) {
      if (err instanceof BodyTooLargeError) throw err;
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const review = store.getReview(pr, sha);
    if (!review) {
      sendJson(res, 409, {
        error:
          "No submitted review to export — submit the review (verdict + summary) first.",
      });
      return;
    }

    const { payload, preview, excludedLocalCount, excludedPendingCount } = buildReviewExport(
      review,
      store.listThreads(pr, sha),
    );
    const existing = store.getExport(pr, sha);
    const available = ctx.github !== undefined;

    if (body.dryRun === true || !available) {
      sendJson(res, 200, {
        dryRun: true,
        available,
        payload,
        preview,
        excludedLocalCount,
        excludedPendingCount,
        reviewExport: existing,
      });
      return;
    }

    if (existing) {
      sendJson(res, 409, {
        error: "This review was already posted to GitHub.",
        reviewExport: existing,
      });
      return;
    }

    // Concurrent non-dry-run guard.
    if (ctx.exportRunningRef.value) {
      sendJson(res, 409, { error: "an export is already in progress" });
      return;
    }

    ctx.exportRunningRef.value = true;
    let out: string;
    try {
      const { owner, repo, gh, repoPath } = ctx.github!;
      out = await gh(
        [
          "api",
          `repos/${owner}/${repo}/pulls/${pr}/reviews`,
          "-X",
          "POST",
          "--input",
          "-",
        ],
        repoPath,
        JSON.stringify(payload),
      );
    } catch (err) {
      // gh surfaces GitHub's 422s (e.g. a comment on a line outside the diff)
      // on stderr; pass the classified message through as readable JSON.
      sendJson(res, 502, {
        error: `GitHub rejected the review: ${errorMessage(err)}`,
      });
      return;
    } finally {
      ctx.exportRunningRef.value = false;
    }

    let reviewId: number | undefined;
    let url: string | null = null;
    try {
      const parsed = JSON.parse(out) as { id?: unknown; html_url?: unknown };
      if (typeof parsed.id === "number") reviewId = parsed.id;
      if (typeof parsed.html_url === "string") url = parsed.html_url;
    } catch {
      // fall through to the bad-output error below
    }
    if (reviewId === undefined) {
      sendJson(res, 502, {
        error:
          "GitHub accepted the request but returned an unexpected response " +
          "(no review id) — check the PR on GitHub before retrying.",
      });
      return;
    }

    const recorded = store.recordExport(pr, sha, { githubReviewId: reviewId, url });
    sendJson(res, 200, {
      dryRun: false,
      reviewExport: recorded,
      preview,
      excludedLocalCount,
      excludedPendingCount,
    });
    return;
  }

  if (route === "POST /api/threads") {
    let body: { anchor?: unknown; body?: unknown; visibility?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch (err) {
      if (err instanceof BodyTooLargeError) throw err;
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    const anchor = AnchorSchema.safeParse(body.anchor);
    if (!anchor.success) {
      sendJson(res, 400, {
        error: "`anchor` must be {file, side, startLine, endLine}",
      });
      return;
    }
    if (typeof body.body !== "string" || body.body.trim() === "") {
      sendJson(res, 400, { error: "`body` (string) is required" });
      return;
    }
    const visibility = parseVisibility(body.visibility);
    if (body.visibility !== undefined && visibility === undefined) {
      sendJson(res, 400, {
        error: "`visibility` must be one of: local, publishable",
      });
      return;
    }
    const thread = store.createThread(pr, sha, anchor.data, {
      author: { type: "reviewer" },
      body: body.body,
      pending: true,
      ...(visibility !== undefined ? { visibility } : {}),
    });
    sendJson(res, 201, thread);
    return;
  }

  const visibilityMatch =
    /^POST \/api\/threads\/([^/]+)\/comments\/([^/]+)\/visibility$/.exec(
      route,
    );
  if (visibilityMatch) {
    const threadId = decodeURIComponent(visibilityMatch[1]!);
    const commentId = decodeURIComponent(visibilityMatch[2]!);
    let body: { visibility?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch (err) {
      if (err instanceof BodyTooLargeError) throw err;
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    const visibility = parseVisibility(body.visibility);
    if (visibility === undefined) {
      sendJson(res, 400, {
        error: "`visibility` must be one of: local, publishable",
      });
      return;
    }

    const thread = store.getThread(pr, sha, threadId);
    const comment = thread?.comments.find((c) => c.id === commentId);
    if (!thread || !comment) {
      sendJson(res, 404, { error: "no such thread/comment" });
      return;
    }
    if (comment.author.type !== "reviewer") {
      sendJson(res, 422, { error: "only reviewer comments" });
      return;
    }

    const updated = store.setCommentVisibility(
      pr,
      sha,
      threadId,
      commentId,
      visibility,
    );
    if (!updated) {
      sendJson(res, 404, { error: "no such thread/comment" });
      return;
    }
    sendJson(res, 200, { ok: true, comment: updated });
    return;
  }

  // /api/threads/:id/<action>
  const match = /^(GET|POST) \/api\/threads\/([^/]+)\/(comments|resolve|unresolve|ask)$/.exec(
    route,
  );
  if (!match || match[1] !== "POST") {
    sendJson(res, 404, { error: `no route: ${route}` });
    return;
  }
  const threadId = decodeURIComponent(match[2]!);
  const action = match[3]!;
  // Thread ids are positional and repeat across PRs; every store lookup is
  // scoped by this server's (pr, sha).
  const thread = store.getThread(pr, sha, threadId);
  if (!thread) {
    sendJson(res, 404, { error: `no such thread: ${threadId}` });
    return;
  }

  if (action === "resolve" || action === "unresolve") {
    const status = action === "resolve" ? "resolved" : "open";
    store.setThreadStatus(pr, sha, threadId, status);
    sendJson(res, 200, { status });
    return;
  }

  if (action === "comments") {
    let body: { body?: unknown; visibility?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch (err) {
      if (err instanceof BodyTooLargeError) throw err;
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (typeof body.body !== "string" || body.body.trim() === "") {
      sendJson(res, 400, { error: "`body` (string) is required" });
      return;
    }
    const visibility = parseVisibility(body.visibility);
    if (body.visibility !== undefined && visibility === undefined) {
      sendJson(res, 400, {
        error: "`visibility` must be one of: local, publishable",
      });
      return;
    }
    const comment = store.addComment(pr, sha, threadId, {
      author: { type: "reviewer" },
      body: body.body,
      pending: true,
      ...(visibility !== undefined ? { visibility } : {}),
    });
    sendJson(res, 201, comment);
    return;
  }

  // action === "ask": stream the Assistant's answer, then persist it.
  let body: { question?: unknown } = {};
  try {
    const raw = await readBody(req);
    if (raw.trim() !== "") body = JSON.parse(raw) as typeof body;
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw err;
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  const question =
    typeof body.question === "string" && body.question.trim() !== ""
      ? body.question.trim()
      : DEFAULT_THREAD_QUESTION;

  const anchor: Anchor = thread.anchor;
  const layer = layerForSelection(
    scaffold,
    anchor.file,
    anchor.side,
    anchor.startLine,
    anchor.endLine,
  );
  const messages = buildAssistantMessages(layer, {
    file: anchor.file,
    lineLabel: `[${anchor.side}] lines ${anchor.startLine}-${anchor.endLine}`,
    question: [
      "This is a review thread on the lines above. Thread so far:",
      "",
      threadTranscript(thread),
      "",
      question,
    ].join("\n"),
    prTitle: ctx.prTitle,
  });

  // Tee the stream so the full answer can be persisted once it completes.
  let full = "";
  const chunks = askAssistant(messages, {
    runner: ctx.localRunner,
    model: ctx.model,
  });
  async function* tee(): AsyncIterable<string> {
    for await (const chunk of chunks) {
      full += chunk;
      yield chunk;
    }
  }
  await streamAnswer(req, res, tee(), "Is Ollama running? Try `ollama serve`.");
  if (full.trim() !== "") {
    try {
      store.addComment(pr, sha, threadId, {
        author: { type: "assistant", model: ctx.model },
        body: full,
        pending: false,
      });
    } catch (err) {
      // The answer already streamed to the client; don't let a persistence
      // failure crash the handler — but don't lose it silently either.
      console.warn(
        `[threads] failed to persist assistant answer for PR ${pr} thread ${threadId}:`,
        err,
      );
    }
  }
}

// ── Agent API + published GitHub conversation ───────────────────────────────────────

const PUBLISHED_CACHE_MS = 15_000;

interface PublishedConversationCache {
  snapshot: PublishedConversationSnapshot | null;
  fetchedAtMs: number;
}

async function fetchPublishedConversation(
  github: GithubExportOptions | undefined,
  pr: number,
  cache: PublishedConversationCache,
  force = false,
): Promise<PublishedConversationSnapshot> {
  if (!github) return emptyPublishedConversation();
  const target = github;
  const now = Date.now();
  if (!force && cache.snapshot && now - cache.fetchedAtMs < PUBLISHED_CACHE_MS) {
    return cache.snapshot;
  }

  const errors: string[] = [];
  const comments = [];
  async function fetchArray(path: string): Promise<unknown[]> {
    try {
      const out = await target.gh(["api", path], target.repoPath);
      const parsed = JSON.parse(out) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      errors.push(`${path}: ${errorMessage(err)}`);
      return [];
    }
  }

  const base = `repos/${target.owner}/${target.repo}`;
  comments.push(
    ...normalizeGithubReviewComments(await fetchArray(`${base}/pulls/${pr}/comments`)),
    ...normalizeGithubReviews(await fetchArray(`${base}/pulls/${pr}/reviews`)),
    ...normalizeGithubIssueComments(await fetchArray(`${base}/issues/${pr}/comments`)),
  );
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const snapshot: PublishedConversationSnapshot = {
    fetchedAt: new Date().toISOString(),
    comments,
    errors,
  };
  cache.snapshot = snapshot;
  cache.fetchedAtMs = now;
  return snapshot;
}

function validateAgentAnchor(value: unknown): { ok: true; anchor: Anchor } | { ok: false; error: string } {
  const parsed = AnchorSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: "`anchor` must be {file, side, startLine, endLine}" };
  }
  if (parsed.data.startLine < 1 || parsed.data.endLine < 1) {
    return { ok: false, error: "`anchor` lines must be positive integers" };
  }
  return { ok: true, anchor: parsed.data };
}

interface AgentRouteContext {
  store?: Store;
  scaffold: ReviewScaffold;
  github?: GithubExportOptions;
  publishedCache: PublishedConversationCache;
}

function localDrafts(threads: Thread[]): Array<{ threadId: string; comment: Comment; anchor: Anchor; status: Thread["status"] }> {
  const out: Array<{ threadId: string; comment: Comment; anchor: Anchor; status: Thread["status"] }> = [];
  for (const thread of threads) {
    for (const comment of thread.comments) {
      if (comment.author.type === "reviewer" && comment.pending) {
        out.push({ threadId: thread.id, comment, anchor: thread.anchor, status: thread.status });
      }
    }
  }
  return out;
}

async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  url: URL,
  ctx: AgentRouteContext,
): Promise<void> {
  const scaffold = ctx.scaffold;
  const pr = scaffold.pr.number;
  const sha = scaffold.pr.headSha;

  if (route === "GET /api/agent/context") {
    const published = await fetchPublishedConversation(
      ctx.github,
      pr,
      ctx.publishedCache,
      url.searchParams.get("refresh") === "1",
    );
    const threads = ctx.store ? ctx.store.listThreads(pr, sha) : [];
    sendJson(res, 200, {
      pr: scaffold.pr,
      headSha: sha,
      layers: scaffold.layers,
      localThreads: threads,
      published,
      endpoints: {
        context: "/api/agent/context",
        comments: "/api/agent/comments",
        createComment: "POST /api/agent/comments",
        setVisibility: "POST /api/agent/comments/:id/visibility",
      },
    });
    return;
  }

  if (route === "GET /api/agent/comments") {
    const published = await fetchPublishedConversation(
      ctx.github,
      pr,
      ctx.publishedCache,
      url.searchParams.get("refresh") === "1",
    );
    const threads = ctx.store ? ctx.store.listThreads(pr, sha) : [];
    sendJson(res, 200, {
      localDrafts: localDrafts(threads),
      published,
    });
    return;
  }

  if (route === "POST /api/agent/comments") {
    if (!ctx.store) {
      sendJson(res, 404, { error: "threads unavailable" });
      return;
    }
    let body: { anchor?: unknown; body?: unknown; visibility?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch (err) {
      if (err instanceof BodyTooLargeError) throw err;
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }

    const anchor = validateAgentAnchor(body.anchor);
    if (!anchor.ok) {
      sendJson(res, 400, { error: anchor.error });
      return;
    }
    if (typeof body.body !== "string" || body.body.trim() === "") {
      sendJson(res, 400, { error: "`body` (string) is required" });
      return;
    }
    const visibility = parseVisibility(body.visibility);
    if (body.visibility !== undefined && visibility === undefined) {
      sendJson(res, 400, { error: "`visibility` must be one of: local, publishable" });
      return;
    }

    const thread = ctx.store.createThread(pr, sha, anchor.anchor, {
      author: { type: "reviewer" },
      body: body.body,
      pending: true,
      visibility: visibility ?? "local",
    });
    sendJson(res, 201, { thread, comment: thread.comments[0] });
    return;
  }

  const visibilityMatch = /^POST \/api\/agent\/comments\/([^/]+)\/visibility$/.exec(route);
  if (visibilityMatch) {
    if (!ctx.store) {
      sendJson(res, 404, { error: "threads unavailable" });
      return;
    }
    const commentId = decodeURIComponent(visibilityMatch[1]!);
    let body: { visibility?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch (err) {
      if (err instanceof BodyTooLargeError) throw err;
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    const visibility = parseVisibility(body.visibility);
    if (visibility === undefined) {
      sendJson(res, 400, { error: "`visibility` must be one of: local, publishable" });
      return;
    }

    const currentThreads = ctx.store.listThreads(pr, sha);
    for (const thread of currentThreads) {
      const comment = thread.comments.find((c) => c.id === commentId);
      if (!comment) continue;
      if (comment.author.type !== "reviewer" || !comment.pending) {
        sendJson(res, 422, { error: "only pending local reviewer drafts can change visibility" });
        return;
      }
      const updated = ctx.store.setCommentVisibility(pr, sha, thread.id, commentId, visibility);
      sendJson(res, 200, { ok: true, comment: updated });
      return;
    }
    sendJson(res, 404, { error: "no such local draft comment" });
    return;
  }

  sendJson(res, 404, { error: `no route: ${route}` });
}

/**
 * Start the review server. Resolves once listening, with the bound port and a
 * close() that shuts the listener down.
 */
export async function startServer(
  opts: StartServerOptions,
): Promise<RunningServer> {
  let model = await resolveOllamaModel(opts.ollamaModel);

  // Boot model override: if there's a stored assistant model choice that's valid
  // against installed Ollama tags, prefer it over the resolved default.
  if (opts.store) {
    try {
      const savedChoices = opts.store.getModelChoices(opts.scaffold.pr.number);
      if (savedChoices?.assistantModel) {
        const tagsRes = await fetch(`${OLLAMA_HOST}/api/tags`).catch(() => null);
        if (tagsRes?.ok) {
          const tagsData = (await tagsRes.json()) as { models?: { name: string }[] };
          const tags = (tagsData.models ?? []).map((m: { name: string }) => m.name);
          if (tags.includes(savedChoices.assistantModel)) {
            model = savedChoices.assistantModel;
          }
        }
      }
    } catch {
      // ignore — fall back to resolved model
    }
  }

  // Mutable in-memory state: model can be switched via POST /api/model;
  // html + scaffold are swapped after a successful scaffold job completes.
  let currentHtml = opts.html;
  let currentScaffold = opts.scaffold;

  // Wave 9B: at most ONE scaffold job at a time per server (the old
  // `scaffoldRunning` semantics), kept with its full event log until the next
  // job replaces it, so a client can reattach to a finished job's tail.
  let currentJob: ScaffoldJob | undefined;
  let finishRunning = false;

  const localRunner = opts.localRunner ?? createOllamaRunner(OLLAMA_HOST);
  const cloudRunner = opts.cloudRunner ?? createDefaultCloudRunner();
  const escalationAvailable = isEscalationAvailable();

  // Shared ref for the concurrent-export guard (referenced from threadCtx).
  const exportRunningRef = { value: false };
  const publishedCache: PublishedConversationCache = {
    snapshot: null,
    fetchedAtMs: 0,
  };

  // Wave-2 thread model: seed one open Thread per Finding (idempotent), so the
  // thread routes serve a populated model from the first request.
  const threadCtx: ThreadRouteContext | undefined = opts.store
    ? {
        store: opts.store,
        scaffold: currentScaffold,
        prTitle: opts.prTitle,
        localRunner,
        model,
        github: opts.github,
        exportRunningRef,
      }
    : undefined;
  threadCtx?.store.seedFindingThreads(currentScaffold);

  // ── Scaffold job driver (Wave 9B) ──────────────────────────────────────────
  //
  // Runs scaffolding.run() to completion INDEPENDENTLY of any HTTP request that
  // started or is watching it. The job owns the seq'd event log; the driver
  // relays run() progress events into it and, on success, persists + swaps
  // in-memory state (the old route's post-run work) from job completion — a
  // disconnected client no longer skips persistence. Only an explicit cancel
  // (job.signal aborts) stops the run; client socket closes are invisible to it.
  function startScaffoldJob(
    runChoice: Parameters<NonNullable<StartServerOptions["scaffolding"]>["run"]>[0],
    choiceString: string,
  ): ScaffoldJob {
    const scaffolding = opts.scaffolding!;
    const job = new ScaffoldJob({ choice: choiceString });
    currentJob = job;

    void (async () => {
      try {
        const result = await scaffolding.run(
          runChoice,
          (e) => job.appendEvent(e as LoggedEvent),
          {
            signal: job.signal,
            onPartialResult: (partial) => {
              // Wave-3A: skeleton landed — serve the partial scaffold so a browser
              // refresh shows the review skeleton instead of the empty placeholder.
              currentHtml = partial.html;
              if (opts.store) {
                try {
                  opts.store.saveScaffold(partial.scaffold);
                  opts.store.setScaffoldPartial(
                    partial.scaffold.pr.number,
                    partial.scaffold.pr.headSha,
                    true,
                  );
                } catch {
                  // Best-effort — a partial persist failure must not abort the run.
                }
              }
            },
          },
        );

        // Cancelled mid-run: run() may still resolve; honour the cancel.
        if (job.signal.aborted) {
          job.appendTerminal({ event: "cancelled" });
          return;
        }

        // Persist + seed threads (only when a store is wired). A persistence
        // failure emits an error terminal event and does NOT swap state.
        if (opts.store) {
          try {
            opts.store.saveScaffold(result.scaffold);
            opts.store.saveModelChoices(result.scaffold.pr.number, {
              scaffolderModel: choiceString,
            });
            opts.store.seedFindingThreads(result.scaffold);
          } catch (storeErr) {
            job.appendTerminal({
              event: "error",
              message:
                "scaffold succeeded but persisting it failed: " +
                errorMessage(storeErr),
            });
            return;
          }
        }

        // Swap in-memory state so GET / and the thread routes serve the new
        // scaffold — from job completion, independent of any attached client.
        currentHtml = result.html;
        currentScaffold = result.scaffold;
        if (threadCtx) threadCtx.scaffold = result.scaffold;

        const totalFindings = result.scaffold.layers.reduce(
          (sum, l) => sum + l.findings.length,
          0,
        );
        job.appendTerminal({
          event: "done",
          layers: result.scaffold.layers.length,
          findings: totalFindings,
        });
      } catch (err) {
        // A cancel that surfaces as a thrown "aborted" is a cancellation, not an error.
        if (job.signal.aborted) {
          job.appendTerminal({ event: "cancelled" });
        } else {
          job.appendTerminal({ event: "error", message: errorMessage(err) });
        }
      }
    })();

    return job;
  }

  // Attach an NDJSON EventStream to a job: replay logged events with seq > since,
  // then follow live until the terminal event, then close. Heartbeats go out as
  // {event:"hb", t} but are never part of the seq'd log. The client socket
  // closing unsubscribes but MUST NOT abort the job.
  function attachStreamToJob(
    req: IncomingMessage,
    res: ServerResponse,
    job: ScaffoldJob,
    since: number,
  ): void {
    const es = createEventStream(req, res);
    es.writeHead("application/x-ndjson");

    const subscriber: Subscriber = {
      onEvent(e) {
        es.writeJson(e);
      },
      onHeartbeat(hb) {
        es.writeJson(hb);
      },
      onEnd() {
        es.end();
      },
    };
    const unsubscribe = job.subscribe(subscriber, since);
    // A socket close detaches this client only — the job runs on.
    es.onAbort(() => unsubscribe());
  }

  const server = createServer(async (req, res) => {
    // Central Host check so every route below is covered (DNS-rebinding guard).
    // server.address() is non-null here: requests only arrive after listen().
    const address = server.address();
    const boundPort = typeof address === "object" && address !== null ? address.port : 0;
    if (!isAllowedHost(req.headers.host, boundPort)) {
      sendJson(res, 403, { error: "forbidden host" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === "GET /") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(currentHtml);
        return;
      }

      if (route === "GET /api/health") {
        sendJson(res, 200, {
          ok: true,
          model,
          escalation: escalationAvailable,
          threads: Boolean(opts.store),
          context: Boolean(opts.contextReader),
          actions: {
            blame: Boolean(opts.actions?.blame),
            open: Boolean(opts.actions?.openSource),
            permalink: opts.github
              ? `https://github.com/${opts.github.owner}/${opts.github.repo}`
              : null,
          },
          // Wave 4A: true when POST /api/review/export can really post to GitHub.
          githubExport: Boolean(opts.store && opts.github),
          agent: true,
          // Wave 4B: true when the /api/versions* routes are live (store-backed).
          versions: Boolean(opts.store),
          // Wave 4C: true when the /api/replies* routes are live (store-backed).
          replies: Boolean(opts.store),
          finish: Boolean(opts.finish?.available),
          // Wave 7: scaffold capability and running state.
          scaffold: {
            available: Boolean(opts.scaffolding?.anthropic || opts.scaffolding?.replay),
            anthropic: Boolean(opts.scaffolding?.anthropic),
            replay: Boolean(opts.scaffolding?.replay),
            running: currentJob?.state === "running",
            ...(opts.scaffolding?.providerLabel
              ? { providerLabel: opts.scaffolding.providerLabel }
              : {}),
          },
          // Additive: only present when an LSP manager is wired in.
          ...(opts.lsp ? { lsp: await opts.lsp.status() } : {}),
        });
        return;
      }

      if (route === "POST /api/finish") {
        if (!opts.finish?.available) {
          sendJson(res, 503, { error: "finish not available for this session" });
          return;
        }
        if (finishRunning) {
          sendJson(res, 409, { error: "finish already running" });
          return;
        }

        finishRunning = true;
        // Start the cleanup before replying: a synchronous throw from run()
        // must become a 500 here, not an uncaught exception that kills the
        // process after a 200 already went out.
        let finishPromise: Promise<void>;
        try {
          finishPromise = opts.finish.run();
        } catch (err) {
          finishRunning = false;
          sendJson(res, 500, { error: errorMessage(err) });
          return;
        }
        sendJson(res, 200, { ok: true });
        finishPromise
          .catch((err) => {
            console.warn("[finish] cleanup failed:", err);
          })
          .finally(() => {
            finishRunning = false;
          });
        return;
      }

      if (
        url.pathname === "/api/agent/context" ||
        url.pathname === "/api/agent/comments" ||
        url.pathname.startsWith("/api/agent/comments/")
      ) {
        await handleAgentRoutes(req, res, route, url, {
          store: opts.store,
          scaffold: currentScaffold,
          github: opts.github,
          publishedCache,
        });
        return;
      }

      if (
        url.pathname === "/api/threads" ||
        url.pathname.startsWith("/api/threads/") ||
        url.pathname === "/api/review" ||
        url.pathname.startsWith("/api/review/")
      ) {
        if (!threadCtx) {
          sendJson(res, 404, { error: "threads unavailable" });
          return;
        }
        await handleThreadRoutes(req, res, route, threadCtx);
        return;
      }

      if (
        url.pathname === "/api/versions" ||
        url.pathname.startsWith("/api/versions/")
      ) {
        if (!opts.store) {
          sendJson(res, 404, { error: "versions unavailable" });
          return;
        }
        handleVersionsRoutes(res, route, url, opts.store, currentScaffold);
        return;
      }

      if (
        url.pathname === "/api/replies" ||
        url.pathname.startsWith("/api/replies/")
      ) {
        if (!opts.store) {
          sendJson(res, 404, { error: "replies unavailable" });
          return;
        }
        await handleRepliesRoutes(req, res, route, opts.store);
        return;
      }

      if (url.pathname.startsWith("/api/lsp/")) {
        await handleLspRoute(req, res, route, opts.lsp, opts.lspWorktree);
        return;
      }

      if (route === "POST /api/context") {
        await handleContextRoute(req, res, opts.contextReader);
        return;
      }

      if (route === "GET /api/filerows") {
        const filePath = url.searchParams.get("file");
        if (!filePath) {
          sendJson(res, 400, { error: "`file` query param is required" });
          return;
        }
        if (!opts.diffFiles) {
          sendJson(res, 404, { error: "filerows not available for this session" });
          return;
        }
        // Build a path→index map on every request (small, cached by V8 JIT after
        // a few calls; opts.diffFiles is the same array reference each time).
        const fi = opts.diffFiles.findIndex((f) => f.path === filePath);
        if (fi === -1) {
          sendJson(res, 404, { error: `unknown file: ${filePath}` });
          return;
        }
        const diffFile = opts.diffFiles[fi]!;
        const ws = wsOnlyRows(diffFile.rows);
        const html = renderFileRowsHtml(fi, diffFile, ws, new Map());
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (route === "GET /api/blame") {
        await handleBlameRoute(res, url, opts.actions);
        return;
      }

      if (route === "POST /api/open") {
        await handleOpenSourceRoute(req, res, opts.actions);
        return;
      }

      if (route === "POST /api/ask" || route === "POST /api/escalate") {
        const escalating = url.pathname === "/api/escalate";
        if (escalating && !escalationAvailable) {
          sendJson(res, 501, {
            error:
              "Scaffolder escalation is unavailable in this session. Set ANTHROPIC_API_KEY " +
              "or configure SLEEK_ESCALATION_PROVIDER/SLEEK_SCAFFOLDER_PROVIDER.",
          });
          return;
        }

        let body: AskBody;
        try {
          body = JSON.parse(await readBody(req)) as AskBody;
        } catch (err) {
          if (err instanceof BodyTooLargeError) throw err;
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (typeof body.question !== "string" || body.question.trim() === "") {
          sendJson(res, 400, { error: "`question` (string) is required" });
          return;
        }

        const layer = resolveLayer(currentScaffold, body);
        const messages = buildAssistantMessages(layer, {
          file: body.file,
          lineLabel: lineLabel(body),
          selectedText: body.selectedText,
          question: body.question,
          prTitle: opts.prTitle,
        });

        const answer = escalating
          ? askOpus(messages, { runner: cloudRunner })
          : askAssistant(messages, { runner: localRunner, model });
        const hint = escalating
          ? "Check your Scaffolder provider credentials/configuration."
          : "Is Ollama running? Try `ollama serve`.";
        await streamAnswer(req, res, answer, hint);
        return;
      }

      // ── Wave 7: model listing, model switch, scaffold run ────────────────────────────

      if (route === "GET /api/models") {
        let ollamaTags: string[] = [];
        try {
          const tagsRes = await fetch(`${OLLAMA_HOST}/api/tags`);
          if (tagsRes.ok) {
            const data = (await tagsRes.json()) as { models?: { name: string }[] };
            ollamaTags = (data.models ?? []).map((m: { name: string }) => m.name);
          }
        } catch {
          // Ollama unreachable — return empty list
        }

        const scaffoldingAvailable = Boolean(
          opts.scaffolding?.anthropic || opts.scaffolding?.replay,
        );

        let scaffolderChosen: string | null = null;
        if (opts.store) {
          try {
            const choices = opts.store.getModelChoices(opts.scaffold.pr.number);
            scaffolderChosen = choices?.scaffolderModel ?? null;
          } catch {
            // ignore
          }
        }

        sendJson(res, 200, {
          assistant: {
            current: model,
            models: ollamaTags,
          },
          scaffolder: {
            available: scaffoldingAvailable,
            anthropic: Boolean(opts.scaffolding?.anthropic),
            replay: Boolean(opts.scaffolding?.replay),
            chosen: scaffolderChosen,
            ...(opts.scaffolding?.providerLabel
              ? { providerLabel: opts.scaffolding.providerLabel }
              : {}),
            models: listScaffolderChoices(process.env, {
              replay: Boolean(opts.scaffolding?.replay),
            }),
          },
        });
        return;
      }

      if (route === "POST /api/model") {
        let body: { model?: unknown };
        try {
          body = JSON.parse(await readBody(req)) as typeof body;
        } catch (err) {
          if (err instanceof BodyTooLargeError) throw err;
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (typeof body.model !== "string" || body.model.trim() === "") {
          sendJson(res, 400, { error: "`model` (string) is required" });
          return;
        }
        const requestedModel = body.model.trim();

        // Validate against installed Ollama tags (reject unknown models).
        let installedTags: string[] = [];
        try {
          const tagsRes = await fetch(`${OLLAMA_HOST}/api/tags`);
          if (tagsRes.ok) {
            const data = (await tagsRes.json()) as { models?: { name: string }[] };
            installedTags = (data.models ?? []).map((m: { name: string }) => m.name);
          }
        } catch {
          // Ollama unreachable — skip validation
        }

        if (installedTags.length > 0 && !installedTags.includes(requestedModel)) {
          sendJson(res, 400, {
            error: `unknown model: "${requestedModel}". Installed: ${installedTags.join(", ")}`,
          });
          return;
        }

        // Switch the live model immediately.
        model = requestedModel;
        if (threadCtx) threadCtx.model = requestedModel;

        // Persist per PR when a store is wired.
        if (opts.store) {
          try {
            opts.store.saveModelChoices(opts.scaffold.pr.number, {
              assistantModel: requestedModel,
            });
          } catch {
            // ignore store failure
          }
        }

        sendJson(res, 200, { ok: true, model: requestedModel });
        return;
      }

      // ── Wave 9B: scaffold job routes (start / stream / status / cancel) ──────

      if (route === "POST /api/scaffold") {
        if (!opts.scaffolding) {
          sendJson(res, 503, { error: "scaffold not available" });
          return;
        }
        if (currentJob?.state === "running") {
          sendJson(res, 409, { error: "already running", jobId: currentJob.id });
          return;
        }

        let body: { scaffolder?: unknown };
        try {
          body = JSON.parse(await readBody(req)) as typeof body;
        } catch (err) {
          if (err instanceof BodyTooLargeError) throw err;
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        const scaffolderChoice = body.scaffolder;
        if (typeof scaffolderChoice !== "string" || scaffolderChoice.trim() === "") {
          sendJson(res, 400, { error: "`scaffolder` (string) is required" });
          return;
        }
        const choiceTrimmed = scaffolderChoice.trim();

        const parsed = parseScaffolderChoice(choiceTrimmed);
        if ("error" in parsed) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        if (parsed.kind === "replay" && !opts.scaffolding.replay) {
          sendJson(res, 400, { error: "replay is not available for this PR" });
          return;
        }

        // Start the background job and stream its log from seq 0. The response
        // socket closing later does NOT stop the job (attachStreamToJob only
        // unsubscribes this client).
        const job = startScaffoldJob(parsed, choiceTrimmed);
        attachStreamToJob(req, res, job, -1);
        return;
      }

      if (route === "GET /api/scaffold/stream") {
        if (!currentJob) {
          sendJson(res, 404, { error: "no scaffold job" });
          return;
        }
        const sinceRaw = url.searchParams.get("since");
        const since = sinceRaw === null ? -1 : Number(sinceRaw);
        attachStreamToJob(req, res, currentJob, Number.isFinite(since) ? since : -1);
        return;
      }

      if (route === "GET /api/scaffold/status") {
        if (!currentJob) {
          sendJson(res, 200, { state: "idle" });
          return;
        }
        sendJson(res, 200, currentJob.status());
        return;
      }

      if (route === "POST /api/scaffold/cancel") {
        // Idempotent: ok even when nothing is running. A running job's abort
        // signal fires; the driver observes it and appends the `cancelled`
        // terminal event (killing the worker process group in demo-data.ts).
        currentJob?.cancel();
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: `no route: ${route}` });
    } catch (err) {
      if (!res.headersSent) {
        if (err instanceof BodyTooLargeError) {
          sendJson(res, 413, { error: errorMessage(err) });
        } else {
          sendJson(res, 500, { error: errorMessage(err) });
        }
      } else {
        res.end();
      }
    }
  });

  // Absorb client-level socket errors at the server level so they never
  // bubble up as unhandled rejections or uncaught exceptions.
  server.on("clientError", (_err, socket) => {
    socket.destroy();
  });
  server.on("connection", (s) => {
    s.on("error", () => {});
  });

  ensureUncaughtSocketGuard();

  const listenHost = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, listenHost, () => resolve());
  });

  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // Don't keep the process alive for idle keep-alive sockets.
        server.closeIdleConnections?.();
      }),
  };
}
