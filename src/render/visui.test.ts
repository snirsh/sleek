import { describe, expect, it } from "vitest";
import { excludedLocalLine, visChipClass, visPostValue, visToggleLabel, visToggleTitle } from "./visui.ts";

describe("visChipClass", () => {
  it("returns localchip for reviewer comments with visibility local", () => {
    expect(visChipClass("reviewer", "local")).toBe("localchip");
  });

  it("returns null for reviewer comments with visibility publishable", () => {
    expect(visChipClass("reviewer", "publishable")).toBeNull();
  });

  it("returns null for reviewer comments with no visibility (default publishable)", () => {
    expect(visChipClass("reviewer", undefined)).toBeNull();
  });

  it("returns null for finding comments regardless of visibility", () => {
    expect(visChipClass("finding", "local")).toBeNull();
    expect(visChipClass("finding", undefined)).toBeNull();
  });

  it("returns null for assistant comments regardless of visibility", () => {
    expect(visChipClass("assistant", "local")).toBeNull();
    expect(visChipClass("assistant", "publishable")).toBeNull();
  });
});

describe("visToggleLabel", () => {
  it("returns Local-only when local is true", () => {
    expect(visToggleLabel(true)).toBe("Local-only");
  });

  it("returns Publishable when local is false", () => {
    expect(visToggleLabel(false)).toBe("Publishable");
  });
});

describe("visToggleTitle", () => {
  it("mentions local-only semantics and action when local is true", () => {
    const t = visToggleTitle(true);
    expect(t).toContain("never posted to GitHub");
    expect(t).toContain("publishable");
  });

  it("mentions GitHub posting and local-only action when local is false", () => {
    const t = visToggleTitle(false);
    expect(t).toContain("GitHub");
    expect(t).toContain("local-only");
  });
});

describe("visPostValue", () => {
  it("returns local when local is true", () => {
    expect(visPostValue(true)).toBe("local");
  });

  it("returns null when local is false (omit from POST body)", () => {
    expect(visPostValue(false)).toBeNull();
  });
});

describe("excludedLocalLine", () => {
  it("returns null when count is 0", () => {
    expect(excludedLocalLine(0)).toBeNull();
  });

  it("returns singular form for count 1", () => {
    expect(excludedLocalLine(1)).toBe("1 local-only comment excluded");
  });

  it("returns plural form for count > 1", () => {
    expect(excludedLocalLine(3)).toBe("3 local-only comments excluded");
  });
});
