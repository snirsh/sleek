/**
 * Scaffold stub server fixture for 9C Playwright proof.
 *
 * This is a THROWAWAY fixture — not part of the product. It implements the
 * frozen Wave-9 protocol over plain node:http and serves the real generated
 * review.html at GET /. It simulates a slow fake run with scripted events.
 *
 * Protocol implemented:
 *   GET  /                          serves scripts/review.html
 *   GET  /api/health                returns {ok:true}
 *   GET  /api/models                returns stub scaffolder config (available:true)
 *   GET  /api/scaffold/status       returns current job state
 *   GET  /api/scaffold/stream?since replays log then follows live
 *   POST /api/scaffold              starts a job (409 if running) + streams from seq 0
 *   POST /api/scaffold/cancel       cancels running job
 *
 * Drop mode: STUB_DROP_AFTER_SEQ=<n> makes the FIRST subscriber stream close
 * abruptly when seq >= n (no terminal event), simulating a transport failure.
 * Subsequent streams are served normally.
 *
 * Timing knobs (env): STUB_HB_MS (default 1000) and STUB_EVENT_MS (default 400).
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

// ── Types ────────────────────────────────────────────────────────────────────

type JobState = "idle" | "running" | "done" | "error" | "cancelled";

interface StubJob {
  jobId: string;
  state: JobState;
  startedAt: number;
  choice: string;
  /** Dense seq log: events[i].seq === i */
  events: Array<Record<string, unknown>>;
  /** AbortController for the fake-run timer chain. */
  runAbort: AbortController;
  /** Pending callbacks waiting for the next appended event. */
  waiters: Array<() => void>;
}

export interface StubHandle {
  baseUrl: string;
  /** Direct access to current job (null if idle). */
  job: () => StubJob | null;
  /** How many streams have been dropped by the drop-mode. */
  dropsUsed: () => number;
  close: () => Promise<void>;
}

// ── Constants ────────────────────────────────────────────────────────────────

// A previously rendered demo review page (demo-review.ts's default output path),
// used as the stub's canned "review ready" payload.
const REVIEW_HTML_PATH = join(process.cwd(), "scripts", "review.html");

// Dynamic env reads (evaluated per-call so tests can override via process.env).
function getHbIntervalMs(): number { return parseInt(process.env["STUB_HB_MS"] ?? "1000", 10); }
function getDropAfterSeq(): number {
  return process.env["STUB_DROP_AFTER_SEQ"] !== undefined
    ? parseInt(process.env["STUB_DROP_AFTER_SEQ"], 10)
    : -1;
}
function getEventDelayMs(): number { return parseInt(process.env["STUB_EVENT_MS"] ?? "400", 10); }

let reviewHtmlCache: string | null = null;
function getReviewHtml(): string {
  if (!reviewHtmlCache) reviewHtmlCache = readFileSync(REVIEW_HTML_PATH, "utf8");
  return reviewHtmlCache;
}

// ── Fake run script ──────────────────────────────────────────────────────────

const FAKE_EVENTS: Array<Record<string, unknown>> = [
  { event: "stage", stage: "ingest", status: "start" },
  { event: "stage", stage: "ingest", status: "done", ms: 120, note: "ok" },
  { event: "stage", stage: "skeleton", status: "start" },
  { event: "stage", stage: "skeleton", status: "done", layers: 3 },
  { event: "stage", stage: "detail", status: "progress", done: 1, total: 3 },
  { event: "stage", stage: "detail", status: "progress", done: 2, total: 3 },
  { event: "stage", stage: "detail", status: "progress", done: 3, total: 3 },
  { event: "done", layers: 3, findings: 7 },
];

function startFakeRun(job: StubJob): void {
  let i = 0;
  function scheduleNext(): void {
    if (job.runAbort.signal.aborted || job.state !== "running") return;
    if (i >= FAKE_EVENTS.length) return;
    setTimeout(() => {
      if (job.runAbort.signal.aborted || job.state !== "running") return;
      const ev = FAKE_EVENTS[i++];
      const evName = ev["event"] as string;
      const isTerminal = evName === "done" || evName === "error" || evName === "cancelled";
      if (isTerminal) job.state = evName as JobState;
      const seq = job.events.length;
      job.events.push({ ...ev, seq });
      const ws = job.waiters.splice(0);
      for (const fn of ws) fn();
      if (!isTerminal) scheduleNext();
    }, getEventDelayMs());
  }
  scheduleNext();
}

// ── Stream helper ─────────────────────────────────────────────────────────────

/** Write one NDJSON line; returns false on error (socket closed). */
function writeEvent(res: ServerResponse, obj: Record<string, unknown>): boolean {
  try {
    return res.write(JSON.stringify(obj) + "\n");
  } catch {
    return false;
  }
}

/**
 * Replay events[startIdx..] to the response, then follow live events.
 * If DROP_AFTER_SEQ is set and this is the first drop, close the stream
 * abruptly when it reaches that seq.
 */
function streamFrom(
  res: ServerResponse,
  req: IncomingMessage,
  job: StubJob,
  startIdx: number,
  dropsUsed: { count: number },
): void {
  let clientClosed = false;
  // Use res.on("close") — fires when the response connection is actually closed
  // (browser navigates away / connection reset). req.on("close") fires too early
  // in Chromium: it fires when the request body is fully consumed, even though
  // the response stream is still active.
  res.on("close", () => { clientClosed = true; });

  const dropAfterSeq = getDropAfterSeq();
  const isDropStream = dropAfterSeq >= 0 && dropsUsed.count === 0;

  let nextIdx = startIdx;

  function flush(): boolean {
    while (nextIdx < job.events.length) {
      const ev = job.events[nextIdx];
      if (isDropStream && typeof ev["seq"] === "number" && (ev["seq"] as number) >= dropAfterSeq) {
        dropsUsed.count++;
        res.end();
        return false; // dropped
      }
      if (!writeEvent(res, ev)) return false;
      nextIdx++;
    }
    return true;
  }

  // Send heartbeats while following live.
  let hbInterval: ReturnType<typeof setInterval> | null = null;

  function follow(): void {
    if (clientClosed) {
      if (hbInterval) clearInterval(hbInterval);
      return;
    }
    if (!flush()) {
      if (hbInterval) clearInterval(hbInterval);
      return; // dropped or socket error
    }
    if (job.state !== "running") {
      if (hbInterval) clearInterval(hbInterval);
      res.end();
      return;
    }
    // Wait for the next event.
    job.waiters.push(() => { setTimeout(follow, 0); });
  }

  // Start: replay existing events.
  if (!flush()) return;

  if (job.state !== "running") {
    res.end();
    return;
  }

  // Start heartbeat for live subscribers.
  hbInterval = setInterval(() => {
    if (clientClosed) { clearInterval(hbInterval!); hbInterval = null; return; }
    writeEvent(res, { event: "hb", t: Date.now() - job.startedAt });
  }, getHbIntervalMs());

  job.waiters.push(() => { setTimeout(follow, 0); });
}

// ── Request handler ───────────────────────────────────────────────────────────

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  jobRef: { current: StubJob | null },
  dropsUsed: { count: number },
): void {
  const method = req.method ?? "GET";
  const urlStr = req.url ?? "/";
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlStr, "http://localhost");
  } catch {
    res.writeHead(400); res.end(); return;
  }
  const path = parsedUrl.pathname;

  res.setHeader("Cache-Control", "no-store");

  // GET /
  if (method === "GET" && path === "/") {
    const html = getReviewHtml();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // GET /api/health
  if (method === "GET" && path === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, scaffold: { available: true } }));
    return;
  }

  // GET /api/models — stub: scaffolder available with one choice.
  // Model entries use the ScaffolderModel shape: id, label, available, group.
  if (method === "GET" && path === "/api/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      assistant: { installed: [], current: null, models: [] },
      scaffolder: {
        available: true,
        anthropic: true,
        replay: false,
        chosen: null,
        models: [
          { id: "claude:opus", label: "Claude Opus", available: true, group: "Anthropic" },
        ],
      },
    }));
    return;
  }

  // GET /api/scaffold/status
  if (method === "GET" && path === "/api/scaffold/status") {
    const job = jobRef.current;
    if (!job) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: "idle" }));
      return;
    }
    const lastSeq = job.events.length > 0 ? job.events[job.events.length - 1]["seq"] : -1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      state: job.state,
      id: job.jobId,
      seq: lastSeq,
      startedAt: job.startedAt,
      choice: job.choice,
    }));
    return;
  }

  // GET /api/scaffold/stream?since=<seq>
  if (method === "GET" && path === "/api/scaffold/stream") {
    const job = jobRef.current;
    if (!job) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no scaffold job" }));
      return;
    }
    const sinceParam = parsedUrl.searchParams.get("since");
    const since = sinceParam !== null ? parseInt(sinceParam, 10) : -1;
    // Start from the first event with seq > since.
    const startIdx = since + 1;
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    streamFrom(res, req, job, startIdx, dropsUsed);
    return;
  }

  // POST /api/scaffold — start a new job
  if (method === "POST" && path === "/api/scaffold") {
    const job = jobRef.current;
    if (job && job.state === "running") {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "already running", jobId: job.jobId }));
      return;
    }

    let bodyStr = "";
    req.on("data", (d: Buffer) => { bodyStr += d.toString(); });
    req.on("end", () => {
      let choice = "claude:opus";
      try {
        const body = JSON.parse(bodyStr) as { scaffolder?: string };
        if (body.scaffolder) choice = body.scaffolder;
      } catch {
        // ignore
      }

      const newJob: StubJob = {
        jobId: "stub-" + Date.now(),
        state: "running",
        startedAt: Date.now(),
        choice,
        events: [],
        runAbort: new AbortController(),
        waiters: [],
      };
      // First event: job announcement.
      newJob.events.push({ event: "job", id: newJob.jobId, seq: 0 });
      jobRef.current = newJob;

      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      // Start streaming from seq 0.
      streamFrom(res, req, newJob, 0, dropsUsed);
      // Schedule the fake run events.
      startFakeRun(newJob);
    });
    return;
  }

  // POST /api/scaffold/cancel
  if (method === "POST" && path === "/api/scaffold/cancel") {
    const job = jobRef.current;
    if (job && job.state === "running") {
      job.runAbort.abort();
      job.state = "cancelled";
      const seq = job.events.length;
      job.events.push({ event: "cancelled", seq });
      const ws = job.waiters.splice(0);
      for (const fn of ws) fn();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found: " + path }));
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startStub(port: number): Promise<StubHandle> {
  const jobRef: { current: StubJob | null } = { current: null };
  const dropsUsed = { count: 0 };

  const server = createServer((req, res) => {
    handleRequest(req, res, jobRef, dropsUsed);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: "http://127.0.0.1:" + addr.port,
        job: () => jobRef.current,
        dropsUsed: () => dropsUsed.count,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
