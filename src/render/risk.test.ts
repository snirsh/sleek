import { describe, expect, it } from "vitest";

import { highestRiskLayer } from "./risk.ts";

const layer = (...sevs: string[]) => ({ findings: sevs.map((severity) => ({ severity })) });

describe("highestRiskLayer", () => {
  it("picks the layer whose WORST finding severity is highest, not the most findings", () => {
    expect(
      highestRiskLayer([layer("minor", "minor", "minor"), layer("info", "critical"), layer("major")]),
    ).toBe(1);
  });

  it("breaks severity ties to the lowest reading order (input order)", () => {
    expect(highestRiskLayer([layer("info"), layer("major"), layer("major", "info")])).toBe(1);
  });

  it("ranks layers with no findings last: they never win", () => {
    expect(highestRiskLayer([layer(), layer("info")])).toBe(1);
  });

  it("returns -1 when no layer has any finding", () => {
    expect(highestRiskLayer([layer(), layer()])).toBe(-1);
    expect(highestRiskLayer([])).toBe(-1);
  });

  it("ignores unknown severities (defensive against malformed data)", () => {
    expect(highestRiskLayer([layer("weird"), layer("minor")])).toBe(1);
  });
});
