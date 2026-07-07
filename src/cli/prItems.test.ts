import { describe, expect, it } from "vitest";
import { relativeAge, prListToPickerItems, parseGhPrList, formatPrList } from "./prItems.ts";
import type { GhPrListEntry } from "./prItems.ts";

describe("relativeAge", () => {
  function now() { return new Date("2024-06-01T12:00:00Z"); }

  it("just now for sub-minute", () => {
    const then = new Date("2024-06-01T11:59:50Z");
    expect(relativeAge(then.toISOString(), now())).toBe("just now");
  });

  it("minutes", () => {
    const then = new Date("2024-06-01T11:55:00Z");
    expect(relativeAge(then.toISOString(), now())).toBe("5m ago");
  });

  it("hours", () => {
    const then = new Date("2024-06-01T10:00:00Z");
    expect(relativeAge(then.toISOString(), now())).toBe("2h ago");
  });

  it("days", () => {
    const then = new Date("2024-05-29T12:00:00Z");
    expect(relativeAge(then.toISOString(), now())).toBe("3d ago");
  });

  it("months", () => {
    const then = new Date("2024-04-01T12:00:00Z");
    expect(relativeAge(then.toISOString(), now())).toBe("2mo ago");
  });

  it("years", () => {
    const then = new Date("2022-06-01T12:00:00Z");
    expect(relativeAge(then.toISOString(), now())).toBe("2y ago");
  });

  it("future date → just now", () => {
    const then = new Date("2024-06-01T13:00:00Z");
    expect(relativeAge(then.toISOString(), now())).toBe("just now");
  });
});

describe("prListToPickerItems", () => {
  const now = new Date("2024-06-01T12:00:00Z");
  const entries: GhPrListEntry[] = [
    {
      number: 123,
      title: "Fix hydration mismatch",
      headRefName: "fix/hydration",
      author: { login: "alice" },
      updatedAt: "2024-05-30T12:00:00Z",
    },
  ];

  it("label is #<pr> <title>", () => {
    const items = prListToPickerItems(entries, now);
    expect(items[0]!.label).toBe("#123 Fix hydration mismatch");
  });

  it("value is stringified PR number", () => {
    const items = prListToPickerItems(entries, now);
    expect(items[0]!.value).toBe("123");
  });

  it("hint includes author:branch and relative age", () => {
    const items = prListToPickerItems(entries, now);
    expect(items[0]!.hint).toContain("alice:fix/hydration");
    expect(items[0]!.hint).toContain("2d ago");
  });
});

describe("parseGhPrList", () => {
  it("parses valid JSON", () => {
    const raw = JSON.stringify([{ number: 1, title: "T", headRefName: "b", author: { login: "u" }, updatedAt: "2024-01-01T00:00:00Z" }]);
    const entries = parseGhPrList(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.number).toBe(1);
  });

  it("throws on non-array", () => {
    expect(() => parseGhPrList("{}")).toThrow();
  });

  it("throws on invalid JSON", () => {
    expect(() => parseGhPrList("not json")).toThrow();
  });
});

describe("formatPrList", () => {
  const now = new Date("2024-06-01T12:00:00Z");

  it("returns no-pr message for empty list", () => {
    expect(formatPrList([], now)).toContain("No open PRs");
  });

  it("includes PR number and title", () => {
    const entries: GhPrListEntry[] = [{
      number: 123,
      title: "My feature",
      headRefName: "feat",
      author: { login: "x" },
      updatedAt: "2024-05-31T12:00:00Z",
    }];
    const out = formatPrList(entries, now);
    expect(out).toContain("123");
    expect(out).toContain("My feature");
    expect(out).toContain("1d ago");
  });
});
