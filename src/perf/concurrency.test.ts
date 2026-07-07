import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "./concurrency.ts";

/** A manually resolvable promise per item, to script completion order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("mapWithConcurrency", () => {
  it("preserves input order even when items complete out of order", async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const result = mapWithConcurrency([0, 1, 2], 3, async (i) => {
      await gates[i]!.promise;
      return `r${i}`;
    });
    // Finish in reverse order — the result array must still be in input order.
    gates[2]!.resolve();
    gates[1]!.resolve();
    gates[0]!.resolve();
    expect(await result).toEqual(["r0", "r1", "r2"]);
  });

  it("never exceeds the concurrency cap (git subprocess guard)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const result = await mapWithConcurrency(items, 8, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight--;
      return i * 2;
    });
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(maxInFlight).toBeGreaterThan(1); // it did actually run in parallel
    expect(result).toEqual(items.map((i) => i * 2));
  });

  it("passes the item index through to fn", async () => {
    const seen: number[] = [];
    await mapWithConcurrency(["a", "b", "c"], 2, async (_item, index) => {
      seen.push(index);
    });
    expect([...seen].sort()).toEqual([0, 1, 2]);
  });

  it("propagates the first rejection and stops starting new work", async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 2, async (i) => {
        started.push(i);
        await tick();
        if (i === 0) throw new Error("region 0 failed");
        return i;
      }),
    ).rejects.toThrow("region 0 failed");
    // With a cap of 2, work beyond the failure point plus in-flight never started.
    expect(started.length).toBeLessThan(8);
  });

  it("handles an empty input and rejects a non-positive cap", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    await expect(mapWithConcurrency([1], 0, async () => 1)).rejects.toThrow(RangeError);
  });
});
