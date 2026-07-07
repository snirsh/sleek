/**
 * Supervised background scaffold job (Wave 9B). A single scaffold run becomes a
 * long-lived job that OUTLIVES the HTTP request that started it: it owns a
 * seq'd append-only event log, a set of live subscribers, a status snapshot, a
 * whole-run watchdog, and a cancel path that fires an AbortSignal.
 *
 * This module is pure-ish and HTTP-free — serve.ts routes are thin adapters
 * over it (POST /api/scaffold starts + streams, GET /stream reattaches, GET
 * /status snapshots, POST /cancel aborts). It is unit-tested without a server.
 *
 * Event log contract (FROZEN — see work/wave9-harness-contract.md):
 *   - Every LOGGED event carries `seq` (integer, 0-based, dense, per job).
 *   - The first logged event is always {event:"job", id, seq:0}.
 *   - Exactly one terminal event ends the log: done | error | cancelled.
 *   - Heartbeats {event:"hb", t:<ms since start>} go to LIVE subscribers only —
 *     they carry NO seq, are never stored, and are never replayed.
 */

/** Progress/terminal events the harness LOGS (each gets a dense `seq`). */
export type LoggedEvent =
  | { event: "job"; id: string }
  | { event: "stage"; stage: "ingest" | "skeleton" | "detail" | "stats"; status: "start" | "done" | "progress"; done?: number; total?: number; layers?: number; findings?: number; ms?: number; note?: string; files?: number; regions?: number; bytes?: number; noiseFiles?: number }
  | { event: "plan"; planLayers: Array<{ id: string; title: string; regionCount: number; files: string[] }>; stackedOnto?: string | null }
  | { event: "partial-scaffold"; layers: Array<{ id: string; title: string; order: number; anchors: Array<{ file: string; side: "LEFT" | "RIGHT"; startLine: number; endLine: number }> }> }
  | { event: "detail"; layer: string; status: "start" | "done" | "retry"; ms?: number; findings?: number }
  | { event: "activity"; layer?: string; text: string }
  | { event: "done"; layers: number; findings: number }
  | { event: "error"; message: string }
  | { event: "cancelled" };

/** A logged event with its assigned dense sequence number. */
export type SeqEvent = LoggedEvent & { seq: number };

/** Heartbeat sent to live subscribers only — never stored, never seq'd. */
export interface Heartbeat {
  event: "hb";
  t: number;
}

/** True once a terminal event (done|error|cancelled) has been appended. */
export type JobState = "running" | "done" | "error" | "cancelled";

export interface JobStatus {
  state: JobState;
  id: string;
  /** seq of the last LOGGED event. */
  seq: number;
  /** epoch ms when the job started. */
  startedAt: number;
  /** the scaffolder choice string this job was started with. */
  choice: string;
}

/**
 * A live subscriber. `onEvent` receives replayed + live seq'd events; `onHeartbeat`
 * (optional) receives heartbeats while running; `onEnd` fires once, right after the
 * terminal event has been delivered (or immediately if already terminal at subscribe).
 */
export interface Subscriber {
  onEvent(e: SeqEvent): void;
  onHeartbeat?(hb: Heartbeat): void;
  onEnd?(): void;
}

const TERMINAL_EVENTS = new Set(["done", "error", "cancelled"]);

/** Default whole-run watchdog: 45 minutes. Override with SLEEK_SCAFFOLD_RUN_TIMEOUT_MS. */
export const DEFAULT_RUN_TIMEOUT_MS = 45 * 60 * 1000;
/** Heartbeat cadence to live subscribers. */
export const HEARTBEAT_INTERVAL_MS = 5000;

let jobCounter = 0;
function nextJobId(now: number): string {
  jobCounter += 1;
  return `job-${now.toString(36)}-${jobCounter}`;
}

export interface ScaffoldJobOptions {
  /** The scaffolder choice string (mirrored into status.choice). */
  choice: string;
  /** Whole-run watchdog in ms; defaults to SLEEK_SCAFFOLD_RUN_TIMEOUT_MS env / 45min. */
  timeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable timer factory for tests (defaults to setInterval/setTimeout). */
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (h: ReturnType<typeof setInterval>) => void;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (h: ReturnType<typeof setTimeout>) => void;
}

/**
 * A single supervised scaffold job. Construct one per POST /api/scaffold; the
 * server keeps exactly one at a time (the previous is replaced), retaining its
 * full log for reattach until then.
 */
export class ScaffoldJob {
  readonly id: string;
  readonly choice: string;
  readonly startedAt: number;
  /** Aborted exactly once by cancel()/watchdog; wired into scaffolding.run(opts.signal). */
  readonly signal: AbortSignal;

  private readonly log: SeqEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private readonly controller = new AbortController();
  private readonly now: () => number;
  private readonly _setInterval: NonNullable<ScaffoldJobOptions["setInterval"]>;
  private readonly _clearInterval: NonNullable<ScaffoldJobOptions["clearInterval"]>;
  private readonly _setTimeout: NonNullable<ScaffoldJobOptions["setTimeout"]>;
  private readonly _clearTimeout: NonNullable<ScaffoldJobOptions["clearTimeout"]>;

  private _state: JobState = "running";
  private cancelled = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: ScaffoldJobOptions) {
    this.now = opts.now ?? Date.now;
    this._setInterval = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this._clearInterval = opts.clearInterval ?? ((h) => clearInterval(h));
    this._setTimeout = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = opts.clearTimeout ?? ((h) => clearTimeout(h));

    this.choice = opts.choice;
    this.startedAt = this.now();
    this.id = nextJobId(this.startedAt);
    this.signal = this.controller.signal;

    // seq 0 is always the {event:"job"} record.
    this.append({ event: "job", id: this.id });

    // Whole-run watchdog: on timeout, cancel + append an error terminal event.
    const timeoutMs =
      opts.timeoutMs ??
      (Number(process.env.SLEEK_SCAFFOLD_RUN_TIMEOUT_MS) ||
        DEFAULT_RUN_TIMEOUT_MS);
    this.watchdogTimer = this._setTimeout(() => {
      if (this.isTerminal()) return;
      // Fire the abort so the worker is killed, then log the timeout error.
      if (!this.cancelled) {
        this.cancelled = true;
        this.controller.abort();
      }
      this.appendTerminal({
        event: "error",
        message: `run timed out after ${timeoutMs} ms`,
      });
    }, timeoutMs);
  }

  get state(): JobState {
    return this._state;
  }

  /** seq of the last logged event (>= 0 always, since seq 0 is {event:"job"}). */
  get lastSeq(): number {
    return this.log.length - 1;
  }

  status(): JobStatus {
    return {
      state: this._state,
      id: this.id,
      seq: this.lastSeq,
      startedAt: this.startedAt,
      choice: this.choice,
    };
  }

  isTerminal(): boolean {
    return this._state !== "running";
  }

  /**
   * Append a non-terminal progress event to the log (assigns dense seq) and
   * fan it out to live subscribers. Ignored once terminal — no event may follow
   * a terminal event.
   */
  appendEvent(e: LoggedEvent): void {
    if (this.isTerminal()) return;
    if (TERMINAL_EVENTS.has(e.event)) {
      this.appendTerminal(e);
      return;
    }
    this.append(e);
  }

  /**
   * Append the single terminal event (done|error|cancelled). The first terminal
   * event wins; later ones are ignored. Stops timers and notifies subscribers.
   */
  appendTerminal(e: LoggedEvent): void {
    if (this.isTerminal()) return;
    this._state = e.event as JobState;
    this.append(e);
    this.stopTimers();
    for (const sub of [...this.subscribers]) {
      sub.onEnd?.();
    }
    this.subscribers.clear();
  }

  private append(e: LoggedEvent): void {
    const seqEvent = { ...e, seq: this.log.length } as SeqEvent;
    this.log.push(seqEvent);
    for (const sub of [...this.subscribers]) {
      sub.onEvent(seqEvent);
    }
  }

  /**
   * Subscribe a live consumer: first REPLAY every logged event with seq > since
   * (default -1 = all, so seq 0 is included), then follow live until terminal.
   * If the job is already terminal, replay through the terminal event then call
   * onEnd — no live registration. Returns an unsubscribe fn (a client socket
   * close calls it; it does NOT abort the job).
   */
  subscribe(sub: Subscriber, since = -1): () => void {
    // Replay the tail.
    for (const e of this.log) {
      if (e.seq > since) sub.onEvent(e);
    }
    if (this.isTerminal()) {
      sub.onEnd?.();
      return () => {};
    }
    this.subscribers.add(sub);
    this.ensureHeartbeat();
    return () => {
      this.subscribers.delete(sub);
      if (this.subscribers.size === 0) this.stopHeartbeat();
    };
  }

  /**
   * Fire the abort signal exactly once (idempotent). Does NOT itself append the
   * `cancelled` event — the run driver observes the aborted signal, stops the
   * worker, and appends `cancelled` (or `error`) as the terminal event. Safe to
   * call when idle/terminal (no-op).
   */
  cancel(): void {
    if (this.cancelled || this.isTerminal()) return;
    this.cancelled = true;
    this.controller.abort();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return;
    if (this.subscribers.size === 0) return;
    this.heartbeatTimer = this._setInterval(() => {
      if (this.isTerminal() || this.subscribers.size === 0) return;
      const hb: Heartbeat = { event: "hb", t: this.now() - this.startedAt };
      for (const sub of [...this.subscribers]) {
        sub.onHeartbeat?.(hb);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      this._clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private stopTimers(): void {
    this.stopHeartbeat();
    if (this.watchdogTimer !== undefined) {
      this._clearTimeout(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }
}
