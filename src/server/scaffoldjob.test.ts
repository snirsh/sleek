import { describe, expect, it, vi } from "vitest";

import { ScaffoldJob, HEARTBEAT_INTERVAL_MS } from "./scaffoldjob.ts";
import type { Heartbeat, SeqEvent } from "./scaffoldjob.ts";

function makeJob(overrides: Partial<ConstructorParameters<typeof ScaffoldJob>[0]> = {}) {
  return new ScaffoldJob({ choice: "replay", timeoutMs: 60_000, ...overrides });
}

describe("ScaffoldJob", () => {
  it("assigns dense seqs starting at 0 with the {event:'job'} record", () => {
    const job = makeJob();
    expect(job.lastSeq).toBe(0);
    const collected: SeqEvent[] = [];
    job.subscribe({ onEvent: (e) => collected.push(e) });
    expect(collected[0]).toMatchObject({ event: "job", id: job.id, seq: 0 });

    job.appendEvent({ event: "stage", stage: "ingest", status: "start" });
    job.appendEvent({ event: "stage", stage: "ingest", status: "done" });
    expect(collected.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(job.lastSeq).toBe(2);
  });

  it("subscribe(since) replays events with seq > since then follows live", () => {
    const job = makeJob();
    job.appendEvent({ event: "stage", stage: "ingest", status: "start" }); // seq 1
    job.appendEvent({ event: "stage", stage: "skeleton", status: "start" }); // seq 2

    const replayed: SeqEvent[] = [];
    job.subscribe({ onEvent: (e) => replayed.push(e) }, 1); // only seq > 1
    expect(replayed.map((e) => e.seq)).toEqual([2]);

    job.appendEvent({ event: "stage", stage: "skeleton", status: "done" }); // seq 3
    expect(replayed.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("subscribe() with default since replays the whole log including seq 0", () => {
    const job = makeJob();
    job.appendEvent({ event: "stage", stage: "ingest", status: "start" });
    const seen: SeqEvent[] = [];
    job.subscribe({ onEvent: (e) => seen.push(e) });
    expect(seen.map((e) => e.seq)).toEqual([0, 1]);
  });

  it("logs the worker stats stage event", () => {
    const job = makeJob();
    const seen: SeqEvent[] = [];
    job.subscribe({ onEvent: (e) => seen.push(e) });

    job.appendEvent({ event: "stage", stage: "stats", status: "done", note: "peakRss=120MB heap=48MB" });

    expect(seen[1]).toMatchObject({
      event: "stage",
      stage: "stats",
      status: "done",
      note: "peakRss=120MB heap=48MB",
      seq: 1,
    });
  });

  it("delivers exactly one terminal event and ignores events after it", () => {
    const job = makeJob();
    const seen: SeqEvent[] = [];
    let ended = 0;
    job.subscribe({ onEvent: (e) => seen.push(e), onEnd: () => ended++ });

    job.appendTerminal({ event: "done", layers: 2, findings: 3 });
    expect(job.state).toBe("done");
    expect(job.isTerminal()).toBe(true);
    expect(ended).toBe(1);

    // No further events land.
    job.appendEvent({ event: "stage", stage: "detail", status: "done" });
    job.appendTerminal({ event: "error", message: "late" });
    expect(seen.filter((e) => e.event === "done")).toHaveLength(1);
    expect(seen.some((e) => e.event === "error")).toBe(false);
    expect(ended).toBe(1);
  });

  it("replays through the terminal event and calls onEnd for a finished job", () => {
    const job = makeJob();
    job.appendEvent({ event: "stage", stage: "ingest", status: "start" });
    job.appendTerminal({ event: "done", layers: 1, findings: 0 });

    const seen: SeqEvent[] = [];
    let ended = 0;
    job.subscribe({ onEvent: (e) => seen.push(e), onEnd: () => ended++ });
    expect(seen.map((e) => e.event)).toEqual(["job", "stage", "done"]);
    expect(ended).toBe(1);
  });

  it("cancel() fires the AbortController exactly once", () => {
    const job = makeJob();
    let aborts = 0;
    job.signal.addEventListener("abort", () => aborts++);
    expect(job.signal.aborted).toBe(false);

    job.cancel();
    job.cancel();
    expect(job.signal.aborted).toBe(true);
    expect(aborts).toBe(1);

    // The driver appends the terminal cancelled event.
    job.appendTerminal({ event: "cancelled" });
    expect(job.state).toBe("cancelled");
  });

  it("cancel() on a terminal job is a no-op", () => {
    const job = makeJob();
    job.appendTerminal({ event: "done", layers: 0, findings: 0 });
    let aborts = 0;
    job.signal.addEventListener("abort", () => aborts++);
    job.cancel();
    expect(aborts).toBe(0);
    expect(job.signal.aborted).toBe(false);
  });

  it("emits heartbeats only to live subscribers, never stored/replayed", () => {
    let tick: (() => void) | undefined;
    const job = makeJob({
      now: (() => {
        let t = 1000;
        return () => (t += 100);
      })(),
      setInterval: (fn) => {
        tick = fn;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {},
    });

    // No subscribers → ticking does nothing (and no timer even started).
    expect(tick).toBeUndefined();

    const events: SeqEvent[] = [];
    const hbs: Heartbeat[] = [];
    const unsub = job.subscribe({
      onEvent: (e) => events.push(e),
      onHeartbeat: (hb) => hbs.push(hb),
    });
    expect(tick).toBeDefined();
    tick!();
    tick!();
    expect(hbs).toHaveLength(2);
    expect(hbs[0]!.event).toBe("hb");
    expect(typeof hbs[0]!.t).toBe("number");

    // Heartbeats are not in the seq'd log.
    expect(job.lastSeq).toBe(0);
    expect(events.some((e) => (e as { event: string }).event === "hb")).toBe(false);

    // After unsubscribe the heartbeat delivers to nobody.
    unsub();
    hbs.length = 0;
    tick!();
    expect(hbs).toHaveLength(0);
  });

  it("watchdog cancels and appends a timeout error terminal event", () => {
    let fire: (() => void) | undefined;
    const job = makeJob({
      timeoutMs: 5,
      setTimeout: (fn) => {
        fire = fn;
        return 2 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => {},
    });
    const seen: SeqEvent[] = [];
    job.subscribe({ onEvent: (e) => seen.push(e) });

    let aborts = 0;
    job.signal.addEventListener("abort", () => aborts++);

    fire!();
    expect(aborts).toBe(1);
    expect(job.state).toBe("error");
    const err = seen.find((e) => e.event === "error") as { message: string };
    expect(err.message).toContain("timed out");
  });

  it("status() snapshots state/id/seq/startedAt/choice", () => {
    const job = makeJob({ choice: "claude:claude-opus-4-8" });
    const s = job.status();
    expect(s).toMatchObject({ state: "running", id: job.id, seq: 0, choice: "claude:claude-opus-4-8" });
    expect(typeof s.startedAt).toBe("number");

    job.appendEvent({ event: "stage", stage: "ingest", status: "start" });
    job.appendTerminal({ event: "done", layers: 1, findings: 1 });
    expect(job.status()).toMatchObject({ state: "done", seq: 2 });
  });

  it("unsubscribe stops the heartbeat timer when the last subscriber leaves", () => {
    const cleared = vi.fn();
    let started = false;
    const job = makeJob({
      setInterval: () => {
        started = true;
        return 9 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: cleared,
    });
    const unsub = job.subscribe({ onEvent: () => {} });
    expect(started).toBe(true);
    unsub();
    expect(cleared).toHaveBeenCalledWith(9);
  });

  it("uses HEARTBEAT_INTERVAL_MS as the heartbeat cadence", () => {
    let capturedMs: number | undefined;
    const job = makeJob({
      setInterval: (_fn, ms) => {
        capturedMs = ms;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {},
    });
    job.subscribe({ onEvent: () => {} });
    expect(capturedMs).toBe(HEARTBEAT_INTERVAL_MS);
  });
});
