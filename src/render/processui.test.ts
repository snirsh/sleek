import { describe, expect, it } from "vitest";

import {
  failPhase,
  lastSeqFromEvents,
  layerHydrationState,
  nextPhase,
  parseNdjson,
  pickerDismissible,
  reattachDecision,
  scaffoldEtaMs,
  scaffoldLatestActivity,
  scaffoldLayerRows,
  scaffoldPartialLayers,
  scaffoldProgressPct,
  scaffoldStageLabel,
} from "./processui.ts";
import type { ScaffoldEvent } from "./processui.ts";

describe("parseNdjson", () => {
  it("parses complete lines and carries the partial tail", () => {
    const a = parseNdjson('{"event":"stage","stage":"skeleton","status":"start"}\n{"event":"stage","stage":"ske');
    expect(a.events).toEqual([{ event: "stage", stage: "skeleton", status: "start" }]);
    expect(a.rest).toBe('{"event":"stage","stage":"ske');
  });

  it("resumes across chunks via the carried rest", () => {
    let buf = "";
    const seen: ScaffoldEvent[] = [];
    for (const chunk of ['{"event":"stage","stage":"detail","stat', 'us":"done"}\n{"event":"done","layers":4,"findings":9}\n']) {
      buf += chunk;
      const r = parseNdjson(buf);
      seen.push(...r.events);
      buf = r.rest;
    }
    expect(seen).toEqual([
      { event: "stage", stage: "detail", status: "done" },
      { event: "done", layers: 4, findings: 9 },
    ]);
    expect(buf).toBe("");
  });

  it("returns no events and the whole buffer when there is no newline", () => {
    const r = parseNdjson('{"event":"done"}');
    expect(r.events).toEqual([]);
    expect(r.rest).toBe('{"event":"done"}');
  });

  it("skips blank and malformed lines without aborting", () => {
    const r = parseNdjson('\n{bad json}\n{"event":"stage","stage":"ingest","status":"done","ms":12}\n');
    expect(r.events).toEqual([{ event: "stage", stage: "ingest", status: "done", ms: 12 }]);
    expect(r.rest).toBe("");
  });

  it("parses the full contract success sequence", () => {
    const body = [
      '{"event":"stage","stage":"ingest","status":"done","ms":123,"note":"ok"}',
      '{"event":"stage","stage":"skeleton","status":"start"}',
      '{"event":"stage","stage":"skeleton","status":"done","layers":4}',
      '{"event":"stage","stage":"detail","status":"progress","done":1,"total":4}',
      '{"event":"stage","stage":"detail","status":"done"}',
      '{"event":"done","layers":4,"findings":9}',
      "",
    ].join("\n");
    const r = parseNdjson(body);
    expect(r.events.map((e) => e.event)).toEqual(["stage", "stage", "stage", "stage", "stage", "done"]);
    expect(r.events[r.events.length - 1]).toEqual({ event: "done", layers: 4, findings: 9 });
  });
});

describe("scaffoldStageLabel", () => {
  it("labels ingest done with ms", () => {
    expect(scaffoldStageLabel({ event: "stage", stage: "ingest", status: "done", ms: 123 })).toBe("Ingest done (123ms)");
  });
  it("labels a start line", () => {
    expect(scaffoldStageLabel({ event: "stage", stage: "skeleton", status: "start" })).toBe("Skeleton…");
  });
  it("labels skeleton done with the layer count", () => {
    expect(scaffoldStageLabel({ event: "stage", stage: "skeleton", status: "done", layers: 4 })).toBe("Skeleton: laid down 4 layers");
    expect(scaffoldStageLabel({ event: "stage", stage: "skeleton", status: "done", layers: 1 })).toBe("Skeleton: laid down 1 layer");
  });
  it("labels detail progress with done/total", () => {
    expect(scaffoldStageLabel({ event: "stage", stage: "detail", status: "progress", done: 2, total: 4 })).toBe("Detail: 2 of 4 layers");
  });
  it("returns empty for non-stage events", () => {
    expect(scaffoldStageLabel({ event: "done", layers: 4, findings: 9 })).toBe("");
    expect(scaffoldStageLabel({ event: "error", message: "boom" })).toBe("");
  });
});

describe("nextPhase / failPhase / pickerDismissible", () => {
  it("stays running on stage events", () => {
    const s = nextPhase("running", { event: "stage", stage: "detail", status: "progress", done: 1, total: 4 });
    expect(s).toEqual({ phase: "running", message: "", terminal: false });
  });
  it("goes done with reload copy on done", () => {
    const s = nextPhase("running", { event: "done", layers: 4, findings: 9 });
    expect(s.phase).toBe("done");
    expect(s.terminal).toBe(true);
    expect(s.message).toBe("Scaffold ready — reloading…");
  });
  it("goes error with the message on error", () => {
    const s = nextPhase("running", { event: "error", message: "model refused" });
    expect(s).toEqual({ phase: "error", message: "model refused", terminal: true });
  });
  it("gives error a default message when none is provided", () => {
    expect(nextPhase("running", { event: "error" }).message).toBe("Scaffolding failed");
  });
  it("failPhase is terminal error", () => {
    expect(failPhase("network error")).toEqual({ phase: "error", message: "network error", terminal: true });
    expect(failPhase("").message).toBe("Scaffolding failed");
  });
  it("blocks dismissal while running or done, allows it idle/error", () => {
    expect(pickerDismissible("idle")).toBe(true);
    expect(pickerDismissible("running")).toBe(false);
    expect(pickerDismissible("done")).toBe(false);
    expect(pickerDismissible("error")).toBe(true);
  });
});

describe("nextPhase Wave-9 extensions", () => {
  it("cancelled → terminal error with Cancelled. copy", () => {
    const s = nextPhase("running", { event: "cancelled" });
    expect(s.phase).toBe("error");
    expect(s.message).toBe("Cancelled.");
    expect(s.terminal).toBe(true);
  });
  it("hb event keeps phase running", () => {
    const s = nextPhase("running", { event: "hb", t: 5000 });
    expect(s).toEqual({ phase: "running", message: "", terminal: false });
  });
  it("job event keeps phase running", () => {
    const s = nextPhase("running", { event: "job", id: "abc", seq: 0 });
    expect(s).toEqual({ phase: "running", message: "", terminal: false });
  });
});

describe("reattachDecision", () => {
  it("returns reattach for running state", () => {
    expect(reattachDecision("running", 0)).toEqual({ action: "reattach", delayMs: 0 });
  });
  it("returns reattach for done state", () => {
    expect(reattachDecision("done", 0)).toEqual({ action: "reattach", delayMs: 0 });
  });
  it("returns reattach for error state", () => {
    expect(reattachDecision("error", 0)).toEqual({ action: "reattach", delayMs: 0 });
  });
  it("returns reattach for cancelled state", () => {
    expect(reattachDecision("cancelled", 0)).toEqual({ action: "reattach", delayMs: 0 });
  });
  it("returns give-up for idle state", () => {
    expect(reattachDecision("idle", 0)).toEqual({ action: "give-up", delayMs: 0 });
  });
  it("unreachable: exponential backoff 1s, 2s, 4s, 8s, 10s cap", () => {
    expect(reattachDecision("unreachable", 0)).toEqual({ action: "poll", delayMs: 1000 });
    expect(reattachDecision("unreachable", 1)).toEqual({ action: "poll", delayMs: 2000 });
    expect(reattachDecision("unreachable", 2)).toEqual({ action: "poll", delayMs: 4000 });
    expect(reattachDecision("unreachable", 3)).toEqual({ action: "poll", delayMs: 8000 });
    expect(reattachDecision("unreachable", 4)).toEqual({ action: "poll", delayMs: 10000 });
    expect(reattachDecision("unreachable", 5)).toEqual({ action: "poll", delayMs: 10000 });
    expect(reattachDecision("unreachable", 6)).toEqual({ action: "poll", delayMs: 10000 });
  });
  it("unreachable: gives up after max attempts", () => {
    expect(reattachDecision("unreachable", 7)).toEqual({ action: "give-up", delayMs: 0 });
  });
});

describe("lastSeqFromEvents", () => {
  it("returns defaultSeq when no events have seq", () => {
    expect(lastSeqFromEvents([{ event: "hb", t: 1000 }], -1)).toBe(-1);
  });
  it("returns the highest seq seen", () => {
    const events: ScaffoldEvent[] = [
      { event: "stage", seq: 2 },
      { event: "stage", seq: 5 },
      { event: "stage", seq: 3 },
    ];
    expect(lastSeqFromEvents(events, -1)).toBe(5);
  });
  it("updates from defaultSeq upward only", () => {
    expect(lastSeqFromEvents([{ event: "stage", seq: 2 }], 10)).toBe(10);
  });
  it("handles empty array", () => {
    expect(lastSeqFromEvents([], 7)).toBe(7);
  });
});

describe("client-shipping contract", () => {
  it("ships to the client backtick-free (fn.toString contract)", () => {
    for (const fn of [parseNdjson, scaffoldStageLabel, nextPhase, failPhase, pickerDismissible, reattachDecision, lastSeqFromEvents, scaffoldProgressPct, scaffoldLayerRows, scaffoldLatestActivity, scaffoldPartialLayers, layerHydrationState, scaffoldEtaMs]) {
      const src = fn.toString();
      expect(src.includes("`"), fn.name + " has a backtick").toBe(false);
      expect(src.includes("${"), fn.name + " has ${").toBe(false);
    }
  });
});

describe("scaffoldProgressPct", () => {
  it("returns 2 with no events", () => {
    expect(scaffoldProgressPct([])).toBe(2);
  });
  it("returns 10 after ingest done", () => {
    expect(scaffoldProgressPct([{ event: "stage", stage: "ingest", status: "done" }])).toBe(10);
  });
  it("returns 15 after skeleton starts", () => {
    expect(scaffoldProgressPct([
      { event: "stage", stage: "ingest", status: "done" },
      { event: "stage", stage: "skeleton", status: "start" },
    ])).toBe(15);
  });
  it("returns 45 after skeleton done", () => {
    expect(scaffoldProgressPct([
      { event: "stage", stage: "skeleton", status: "done" },
    ])).toBe(45);
  });
  it("returns 100 on done event", () => {
    expect(scaffoldProgressPct([{ event: "done", layers: 4, findings: 9 }])).toBe(100);
  });
  it("returns intermediate pct during detail", () => {
    const pct = scaffoldProgressPct([
      { event: "stage", stage: "skeleton", status: "done" },
      { event: "stage", stage: "detail", status: "progress", done: 2, total: 4 },
    ]);
    expect(pct).toBe(73);
  });
});

describe("scaffoldLayerRows", () => {
  it("returns empty before plan event", () => {
    expect(scaffoldLayerRows([])).toEqual([]);
  });
  it("returns queued rows after plan event", () => {
    const rows = scaffoldLayerRows([{
      event: "plan",
      planLayers: [
        { id: "L1", title: "Auth layer", regionCount: 3, files: ["a.ts"] },
        { id: "L2", title: "API layer", regionCount: 5, files: ["b.ts"] },
      ],
    }]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: "L1", title: "Auth layer", regionCount: 3, status: "queued", findings: 0 });
    expect(rows[1]).toEqual({ id: "L2", title: "API layer", regionCount: 5, status: "queued", findings: 0 });
  });
  it("marks a row running on detail start", () => {
    const rows = scaffoldLayerRows([
      { event: "plan", planLayers: [{ id: "L1", title: "Auth", regionCount: 2, files: [] }] },
      { event: "detail", layer: "L1", status: "start" },
    ]);
    expect(rows[0].status).toBe("running");
  });
  it("marks a row done with findings on detail done", () => {
    const rows = scaffoldLayerRows([
      { event: "plan", planLayers: [{ id: "L1", title: "Auth", regionCount: 2, files: [] }] },
      { event: "detail", layer: "L1", status: "start" },
      { event: "detail", layer: "L1", status: "done", findings: 3 },
    ]);
    expect(rows[0]).toEqual({ id: "L1", title: "Auth", regionCount: 2, status: "done", findings: 3 });
  });
  it("reconstructs correctly from replayed events", () => {
    const rows = scaffoldLayerRows([
      { event: "plan", planLayers: [
        { id: "L1", title: "Auth", regionCount: 2, files: [] },
        { id: "L2", title: "API", regionCount: 4, files: [] },
      ]},
      { event: "detail", layer: "L1", status: "start" },
      { event: "detail", layer: "L1", status: "done", findings: 2 },
      { event: "detail", layer: "L2", status: "start" },
    ]);
    expect(rows[0].status).toBe("done");
    expect(rows[1].status).toBe("running");
  });
});

describe("scaffoldLatestActivity", () => {
  it("returns empty string with no activity", () => {
    expect(scaffoldLatestActivity([])).toBe("");
  });
  it("returns last activity text", () => {
    expect(scaffoldLatestActivity([
      { event: "activity", text: "reading auth.ts" },
      { event: "activity", text: "reading api.ts" },
    ])).toBe("reading api.ts");
  });
});

describe("scaffoldPartialLayers (Wave 3A)", () => {
  it("returns [] before any partial-scaffold event", () => {
    expect(scaffoldPartialLayers([])).toEqual([]);
    expect(scaffoldPartialLayers([{ event: "stage", stage: "ingest", status: "done" }])).toEqual([]);
  });
  it("returns layers from a partial-scaffold event", () => {
    const layers = [{ id: "L1", title: "Auth", order: 0, anchors: [{ file: "a.ts", side: "LEFT", startLine: 1, endLine: 10 }] }];
    const result = scaffoldPartialLayers([{ event: "partial-scaffold", partialLayers: layers }]);
    expect(result).toEqual(layers);
  });
  it("last partial-scaffold event wins", () => {
    const first = [{ id: "L1", title: "Auth", order: 0, anchors: [] }];
    const second = [{ id: "L2", title: "API", order: 1, anchors: [] }];
    const result = scaffoldPartialLayers([
      { event: "partial-scaffold", partialLayers: first },
      { event: "partial-scaffold", partialLayers: second },
    ]);
    expect(result).toEqual(second);
  });
  it("returns [] when partialLayers is not an array", () => {
    expect(scaffoldPartialLayers([{ event: "partial-scaffold" }])).toEqual([]);
  });
});

describe("layerHydrationState (Wave 3A)", () => {
  it("done -> hydrated", () => {
    expect(layerHydrationState({ status: "done" })).toBe("hydrated");
  });
  it("running -> shimmer", () => {
    expect(layerHydrationState({ status: "running" })).toBe("shimmer");
  });
  it("queued -> queued", () => {
    expect(layerHydrationState({ status: "queued" })).toBe("queued");
  });
});

describe("scaffoldEtaMs (Wave 3B)", () => {
  it("returns null when done event is present", () => {
    expect(scaffoldEtaMs([{ event: "done", layers: 4, findings: 9 }], null)).toBeNull();
  });
  it("returns a number when running with no history", () => {
    const ms = scaffoldEtaMs([{ event: "stage", stage: "ingest", status: "done", files: 20, regions: 50 }], null);
    expect(typeof ms).toBe("number");
    expect(ms).toBeGreaterThan(0);
  });
  it("falls back to weights when historyMs returns null", () => {
    const ms = scaffoldEtaMs([], () => null);
    expect(typeof ms).toBe("number");
  });
  it("uses history when provided", () => {
    const ms = scaffoldEtaMs([], () => 60000);
    // at pct=2 (no events): remaining = 60000 * 0.98 = 58800
    expect(ms).toBe(Math.round(60000 * (1 - 2 / 100)));
  });
  it("returns null when pct >= 100", () => {
    const events = [{ event: "done", layers: 4, findings: 9 }];
    expect(scaffoldEtaMs(events, null)).toBeNull();
  });
});
