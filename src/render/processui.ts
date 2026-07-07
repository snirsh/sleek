/**
 * Pure helpers for the Wave-7 Scaffolder run: parsing the POST /api/scaffold
 * NDJSON stream into events, labelling stage progress lines, and the picker
 * modal's small state machine (idle → running → done|error). The client owns
 * the fetch + DOM; these keep the parsing and copy decisions testable.
 *
 * SHIPPING MODEL (same as versionsui.ts / modelsui.ts): these exact functions
 * also run in the browser — client.ts injects each fn.toString() into
 * CLIENT_JS, so every body must stay fully self-contained: no imports, no
 * references to module scope, no TS-only runtime syntax, and NO backticks or
 * ${} (client code is string-concat only). processui.test.ts covers the very
 * functions the page runs. (The type-only shapes below are erased.)
 */

/** A parsed NDJSON event from POST /api/scaffold (see the contract). */
export interface ScaffoldEvent {
  event: string;
  stage?: string;
  status?: string;
  ms?: number;
  note?: string;
  layers?: number;
  findings?: number;
  done?: number;
  total?: number;
  message?: string;
  /** Wave-9: sequence number assigned by the job log (absent on hb). */
  seq?: number;
  /** Wave-9: job id (on job event). */
  id?: string;
  /** Wave-9: timestamp ms since job start (on hb). */
  t?: number;
  /** Wave-2: layer plan (plan event). */
  planLayers?: Array<{id: string; title: string; regionCount: number; files: string[]}>;
  /** Wave-2: activity text. */
  text?: string;
  /** Wave-2: ingest counts. */
  files?: number;
  regions?: number;
  noiseFiles?: number;
  /** Wave-2: stackedOnto for plan. */
  stackedOnto?: string | null;
  /** Wave-2: per-layer detail events. */
  layer?: string;
  /** Wave-3: partial scaffold layers (partial-scaffold event). */
  partialLayers?: Array<{id: string; title: string; order: number; anchors: Array<{file: string; side: string; startLine: number; endLine: number}>}>;
}

/** Result of feeding a chunk to the incremental NDJSON parser. */
export interface NdjsonParse {
  /** Complete lines parsed from this buffer, in order. */
  events: ScaffoldEvent[];
  /** Trailing partial line to carry into the next chunk. */
  rest: string;
}

/**
 * Incremental NDJSON parser: split a running buffer on newlines, JSON.parse each
 * COMPLETE line, and hand back the parsed events plus the unterminated tail to
 * prepend to the next chunk. Blank lines and lines that don't parse are skipped
 * (a defensive stance — a malformed line never aborts the stream). The final
 * chunk should be flushed by calling once more with a trailing "\n" appended, or
 * by treating a non-empty `rest` at stream end as a last line.
 */
export function parseNdjson(buffer: string): NdjsonParse {
  const events: ScaffoldEvent[] = [];
  const nl = buffer.lastIndexOf("\n");
  if (nl === -1) return { events: events, rest: buffer };
  const complete = buffer.slice(0, nl);
  const rest = buffer.slice(nl + 1);
  const lines = complete.split("\n");
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(s);
    } catch (_) {
      parsed = null;
    }
    if (parsed && typeof parsed === "object" && typeof parsed.event === "string") {
      events.push(parsed);
    }
  }
  return { events: events, rest: rest };
}

/**
 * A one-line, human label for a `stage` event, e.g.
 * "Skeleton: laid down 4 layers", "Detail: 2 of 4 layers", "Ingest done (123ms)".
 * Non-stage events return "" (the client handles done/error separately). Unknown
 * stages fall back to a titlecased stage name plus its status.
 */
export function scaffoldStageLabel(e: ScaffoldEvent): string {
  if (e.event !== "stage" || !e.stage) return "";
  const name = e.stage.charAt(0).toUpperCase() + e.stage.slice(1);
  if (e.stage === "skeleton" && e.status === "done" && typeof e.layers === "number") {
    return "Skeleton: laid down " + e.layers + " layer" + (e.layers === 1 ? "" : "s");
  }
  if (e.stage === "detail" && e.status === "progress" && typeof e.done === "number" && typeof e.total === "number") {
    return "Detail: " + e.done + " of " + e.total + " layer" + (e.total === 1 ? "" : "s");
  }
  if (e.status === "start") return name + "…";
  if (e.status === "done") {
    const ms = typeof e.ms === "number" ? " (" + e.ms + "ms)" : "";
    return name + " done" + ms;
  }
  if (e.status === "progress") return name + "…";
  return name + (e.status ? ": " + e.status : "");
}

/** The picker modal's phase. */
export type ScaffoldPhase = "idle" | "running" | "done" | "error";

/** The next picker phase after an event arrives (or a network failure). */
export interface PhaseStep {
  phase: ScaffoldPhase;
  /** Terminal message to surface (done copy or the error text). */
  message: string;
  /** True once the run is over (done or error) — controls dismissibility. */
  terminal: boolean;
}

/**
 * Advance the picker's phase from the current one given the next event. `done`
 * → the brief "Scaffold ready — reloading…" copy (the client then reloads);
 * `error` → the error message (Close/Retry). Stage events keep it "running".
 * While running, Esc/click-away must stay disabled (terminal=false).
 * Wave-9: `cancelled` → terminal "Cancelled."; `hb`/`job` keep phase running
 * (heartbeats and job-start events are informational, not state transitions).
 */
export function nextPhase(current: ScaffoldPhase, e: ScaffoldEvent): PhaseStep {
  if (e.event === "done") {
    return { phase: "done", message: "Scaffold ready — reloading…", terminal: true };
  }
  if (e.event === "error") {
    const msg = e.message && e.message.length ? e.message : "Scaffolding failed";
    return { phase: "error", message: msg, terminal: true };
  }
  if (e.event === "cancelled") {
    return { phase: "error", message: "Cancelled.", terminal: true };
  }
  // hb (heartbeat) and job events are informational — keep phase running.
  return { phase: "running", message: "", terminal: false };
}

/**
 * The phase after a transport-level failure (fetch reject, non-OK status, or a
 * stream that ended without a done/error line). Always terminal error so the
 * modal offers Retry rather than hanging in "running".
 */
export function failPhase(message: string): PhaseStep {
  return { phase: "error", message: message || "Scaffolding failed", terminal: true };
}

/** Whether the modal may be dismissed (Esc/click-away) in the given phase. */
export function pickerDismissible(phase: ScaffoldPhase): boolean {
  return phase !== "running" && phase !== "done";
}

/**
 * Wave-9 reattach decision helper. Given the current server status string
 * ("running" | "done" | "error" | "cancelled" | "idle" | "unreachable") and
 * the number of prior reattach attempts, returns one of three actions:
 *
 *   "reattach"   — stream is live; connect GET /api/scaffold/stream?since=…
 *   "poll"       — server unreachable; wait the returned ms then try again
 *   "give-up"    — total wait would exceed ~60s; call failPhase
 *
 * Backoff sequence for "unreachable": 1s, 2s, 4s, 8s, capped at 10s.
 * After ~60s cumulative (7 attempts: 1+2+4+8+10+10+10=45s actually; we cut at
 * attempt 7 which would push past 45s) we give up. The contract says ~60s so
 * we aim conservatively.
 *
 * NOTE: no backticks, no ${}, no imports — browser-shipped function.
 */
export function reattachDecision(status: string, attempts: number): { action: "reattach" | "poll" | "give-up"; delayMs: number } {
  // Terminal states from the server — reattach immediately to replay tail.
  if (status === "running" || status === "done" || status === "error" || status === "cancelled") {
    return { action: "reattach", delayMs: 0 };
  }
  // "idle" means no job has ever run — give up immediately (shouldn't happen mid-run).
  if (status === "idle") {
    return { action: "give-up", delayMs: 0 };
  }
  // "unreachable" — backoff: 1s, 2s, 4s, 8s, then cap at 10s.
  // Cumulative after 7 attempts: 1+2+4+8+10+10+10 = 45s; give up after attempt 6 (index 6).
  var backoffs = [1000, 2000, 4000, 8000, 10000, 10000, 10000];
  if (attempts >= backoffs.length) {
    return { action: "give-up", delayMs: 0 };
  }
  return { action: "poll", delayMs: backoffs[attempts] };
}

/**
 * Wave-9 seq-tracking helper. Returns the highest seq value seen in the given
 * array of events, or the provided default if none carry a seq field.
 * Used by the client to pass ?since=<lastSeq> on reattach.
 *
 * NOTE: no backticks, no ${}, no imports — browser-shipped function.
 */
export function lastSeqFromEvents(events: ScaffoldEvent[], defaultSeq: number): number {
  var last = defaultSeq;
  for (var i = 0; i < events.length; i++) {
    var s = events[i].seq;
    if (typeof s === "number" && s > last) {
      last = s;
    }
  }
  return last;
}

/**
 * Wave-2: Derive overall scaffold progress as 0-100.
 * Bands: 2 (no events) → 10 (ingest done) → 15 (skeleton started) →
 * 45 (skeleton done) → 45-100 (detail progress) → 100 (done).
 *
 * NOTE: no backticks, no ${}, no imports — browser-shipped function.
 */
export function scaffoldProgressPct(events: ScaffoldEvent[]): number {
  var ingestDone = false;
  var skeletonStarted = false;
  var skeletonDone = false;
  var detailTotal = 0;
  var detailDone = 0;
  var detailFinished = false;
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    if (e.event === "stage") {
      if (e.stage === "ingest" && e.status === "done") ingestDone = true;
      if (e.stage === "skeleton" && e.status === "start") skeletonStarted = true;
      if (e.stage === "skeleton" && e.status === "done") skeletonDone = true;
      if (e.stage === "detail" && e.status === "progress") {
        if (typeof e.done === "number") detailDone = e.done;
        if (typeof e.total === "number") detailTotal = e.total;
      }
      if (e.stage === "detail" && e.status === "done") detailFinished = true;
    }
    if (e.event === "done") return 100;
  }
  if (detailFinished) return 100;
  if (skeletonDone) {
    var frac = detailTotal > 0 ? detailDone / detailTotal : 0;
    return Math.round(45 + frac * 55);
  }
  if (skeletonStarted) return 15;
  if (ingestDone) return 10;
  return 2;
}

/**
 * Wave-2: Build per-layer status rows from the event stream.
 * Starts from the latest "plan" event, then applies "detail" start/done events.
 *
 * NOTE: no backticks, no ${}, no imports — browser-shipped function.
 */
export function scaffoldLayerRows(events: ScaffoldEvent[]): Array<{id: string; title: string; regionCount: number; status: "queued"|"running"|"done"; findings: number}> {
  var rows: {id: string; title: string; regionCount: number; status: "queued"|"running"|"done"; findings: number}[] = [];
  var rowIndex: {[id: string]: number} = {};
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    if (e.event === "plan" && e.planLayers) {
      rows = [];
      rowIndex = {};
      for (var j = 0; j < e.planLayers.length; j++) {
        var pl = e.planLayers[j];
        rows.push({ id: pl.id, title: pl.title, regionCount: pl.regionCount, status: "queued", findings: 0 });
        rowIndex[pl.id] = j;
      }
    }
    if (e.event === "detail" && e.layer) {
      var idx = rowIndex[e.layer];
      if (typeof idx === "number") {
        if (e.status === "start") {
          rows[idx].status = "running";
        } else if (e.status === "done") {
          rows[idx].status = "done";
          if (typeof e.findings === "number") rows[idx].findings = e.findings;
        }
      }
    }
  }
  return rows;
}

/**
 * Wave-2: Return the last activity text from the event stream, or "".
 *
 * NOTE: no backticks, no ${}, no imports — browser-shipped function.
 */
export function scaffoldLatestActivity(events: ScaffoldEvent[]): string {
  var last = "";
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    if (e.event === "activity" && typeof e.text === "string") {
      last = e.text;
    }
  }
  return last;
}

/**
 * Wave-3A: Extract partial layer states from event stream.
 * Returns the layers array from the latest partial-scaffold event, or [] if none.
 * Each layer has anchors but no findings yet — the client renders "analyzing..." shimmer.
 *
 * NOTE: no backticks, no ${}, no imports — browser-shipped function.
 */
export function scaffoldPartialLayers(events: ScaffoldEvent[]): Array<{id: string; title: string; order: number; anchors: Array<{file: string; side: string; startLine: number; endLine: number}>}> {
  var result: Array<{id: string; title: string; order: number; anchors: Array<{file: string; side: string; startLine: number; endLine: number}>}> = [];
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    if (e.event === "partial-scaffold" && Array.isArray(e.partialLayers)) {
      result = e.partialLayers;
    }
  }
  return result;
}

/**
 * Wave-3A: For a layer row, determine if its findings have arrived.
 * Returns "shimmer" (analyzing), "hydrated" (findings arrived), or "queued" (not started).
 *
 * NOTE: no backticks, no ${}, no imports — browser-shipped function.
 */
export function layerHydrationState(layerRow: {status: "queued"|"running"|"done"}): "shimmer"|"hydrated"|"queued" {
  if (layerRow.status === "done") return "hydrated";
  if (layerRow.status === "running") return "shimmer";
  return "queued";
}

/**
 * Wave-3B: Compute estimated ms remaining from current progress.
 * historyMs: optional lookup fn(bucket, phase) returning number or null (median from DB).
 * Falls back to the deterministic phase weights when historyMs is null or returns null.
 * Returns null when progress is 100 or run is done (no ETA needed).
 *
 * Phase weights (ms) - calibrated rough estimates for a medium PR (~30 files, ~60 regions):
 *   ingest: 5000, skeleton: 30000, detail: 55000 total.
 * Bucket: derived from files + regions counts in the event stream.
 *
 * NOTE: no backticks, no ${}, no imports — browser-shipped function.
 */
export function scaffoldEtaMs(
  events: ScaffoldEvent[],
  historyMs: ((bucket: string, phase: string) => number | null) | null
): number | null {
  var files = 0;
  var regions = 0;
  var isDone = false;

  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    if (e.event === "done") { isDone = true; break; }
    if (e.event === "stage") {
      if (e.stage === "ingest" && e.status === "done") {
        if (typeof e.files === "number") files = e.files;
        if (typeof e.regions === "number") regions = e.regions;
      }
    }
  }

  if (isDone) return null;

  var fBucket = files < 10 ? "0-9" : files < 50 ? "10-49" : files < 100 ? "50-99" : "100+";
  var rBucket = regions < 25 ? "0-24" : regions < 100 ? "25-99" : regions < 200 ? "100-199" : "200+";
  var bucket = "files:" + fBucket + ",regions:" + rBucket;

  var totalMs = historyMs ? historyMs(bucket, "total") : null;
  if (totalMs === null) {
    totalMs = 90000;
  }

  var pct = scaffoldProgressPct(events);
  if (pct >= 100) return null;
  var elapsed = (pct / 100) * totalMs;
  var remaining = totalMs - elapsed;
  return remaining > 0 ? Math.round(remaining) : null;
}
