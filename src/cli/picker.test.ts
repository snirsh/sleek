import { describe, expect, it } from "vitest";
import {
  pickerInit,
  pickerKey,
  decodeKey,
  pickerRender,
  pickerFilterItems,
  pickerFuzzyScore,
  type PickerItem,
  type PickerState,
} from "./picker.ts";

describe("pickerInit", () => {
  it("returns cancelled state for empty items", () => {
    const state = pickerInit([], 3);
    expect(state.done).toEqual({ kind: "cancelled" });
    expect(state.cursor).toBe(0);
    expect(state.offset).toBe(0);
    expect(state.height).toBe(3);
  });

  it("returns active state with non-empty items", () => {
    const items: PickerItem[] = [{ value: "a", label: "A" }];
    const state = pickerInit(items, 3);
    expect(state.done).toBe(null);
    expect(state.cursor).toBe(0);
    expect(state.offset).toBe(0);
    expect(state.query).toBe("");
    expect(state.items).toBe(items);
    expect(state.allItems).toBe(items);
  });

  it("initializes cursor and offset to 0", () => {
    const items = [
      { value: "1", label: "Item 1" },
      { value: "2", label: "Item 2" },
    ];
    const state = pickerInit(items, 5);
    expect(state.cursor).toBe(0);
    expect(state.offset).toBe(0);
  });
});

describe("pickerKey - navigation up/down", () => {
  const items = [
    { value: "1", label: "Item 1" },
    { value: "2", label: "Item 2" },
    { value: "3", label: "Item 3" },
    { value: "4", label: "Item 4" },
  ];

  it("up clamps at zero", () => {
    const state = pickerInit(items, 2);
    const next = pickerKey(state, "up");
    expect(next.cursor).toBe(0);
  });

  it("down from middle moves cursor down", () => {
    let state = pickerInit(items, 2);
    state = pickerKey(state, "down");
    expect(state.cursor).toBe(1);
  });

  it("down clamps at items.length - 1", () => {
    let state = pickerInit(items, 2);
    state = pickerKey(state, "down");
    state = pickerKey(state, "down");
    state = pickerKey(state, "down");
    state = pickerKey(state, "down");
    state = pickerKey(state, "down");
    expect(state.cursor).toBe(items.length - 1);
  });

  it("up from position 2 moves to position 1", () => {
    let state = pickerInit(items, 2);
    state = pickerKey(state, "down");
    state = pickerKey(state, "down");
    state = pickerKey(state, "up");
    expect(state.cursor).toBe(1);
  });

  it("offset scrolls down to keep cursor visible", () => {
    let state = pickerInit(items, 2);
    // Move down 3 times: cursor will be at 3, but offset should follow
    state = pickerKey(state, "down");
    state = pickerKey(state, "down");
    state = pickerKey(state, "down");
    expect(state.cursor).toBe(3);
    expect(state.offset).toBe(2); // cursor 3 at index 1 within height 2, so offset=3-2+1=2
  });

  it("offset scrolls up to keep cursor visible", () => {
    let state = pickerInit(items, 2);
    state = pickerKey(state, "down");
    state = pickerKey(state, "down");
    state = pickerKey(state, "down");
    expect(state.offset).toBe(2);
    state = pickerKey(state, "up");
    state = pickerKey(state, "up");
    expect(state.cursor).toBe(1);
    expect(state.offset).toBe(1);
  });
});

describe("pickerKey - page keys", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    value: `${i}`,
    label: `Item ${i}`,
  }));

  it("pageup moves cursor up by height", () => {
    let state = pickerInit(items, 3);
    // Move to cursor 8
    state = pickerKey(state, "pagedown");
    state = pickerKey(state, "pagedown");
    expect(state.cursor).toBe(6);
    // pageup should move to max(0, 6 - 3) = 3
    state = pickerKey(state, "pageup");
    expect(state.cursor).toBe(3);
  });

  it("pagedown moves cursor down by height", () => {
    let state = pickerInit(items, 3);
    state = pickerKey(state, "pagedown");
    expect(state.cursor).toBe(3);
  });

  it("pageup at beginning clamps to 0", () => {
    const state = pickerInit(items, 5);
    const next = pickerKey(state, "pageup");
    expect(next.cursor).toBe(0);
  });

  it("pagedown at end clamps to items.length - 1", () => {
    let state = pickerInit(items, 3);
    // Keep pagedown until we reach the end
    for (let i = 0; i < 10; i++) {
      state = pickerKey(state, "pagedown");
    }
    expect(state.cursor).toBe(items.length - 1);
  });
});

describe("pickerKey - home/end", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    value: `${i}`,
    label: `Item ${i}`,
  }));

  it("home moves to cursor 0 and offset 0", () => {
    let state = pickerInit(items, 2);
    state = pickerKey(state, "down");
    state = pickerKey(state, "down");
    state = pickerKey(state, "down");
    state = pickerKey(state, "home");
    expect(state.cursor).toBe(0);
    expect(state.offset).toBe(0);
  });

  it("end moves to last item", () => {
    let state = pickerInit(items, 2);
    state = pickerKey(state, "end");
    expect(state.cursor).toBe(items.length - 1);
  });

  it("end adjusts offset so cursor is visible", () => {
    let state = pickerInit(items, 2);
    state = pickerKey(state, "end");
    expect(state.cursor).toBe(9);
    expect(state.offset).toBe(8); // offset should be 9 - 2 + 1 = 8
  });
});

describe("pickerKey - enter/escape", () => {
  const items = [
    { value: "a", label: "Option A" },
    { value: "b", label: "Option B" },
  ];

  it("enter sets done to selected with current item value", () => {
    let state = pickerInit(items, 2);
    state = pickerKey(state, "down");
    const result = pickerKey(state, "enter");
    expect(result.done).toEqual({ kind: "selected", value: "b" });
  });

  it("escape sets done to cancelled", () => {
    const state = pickerInit(items, 2);
    const result = pickerKey(state, "escape");
    expect(result.done).toEqual({ kind: "cancelled" });
  });
});

describe("pickerKey - fuzzy filtering", () => {
  const items = [
    { value: "101", label: "#101 Fix hydration mismatch", hint: "alice:fix/hydration" },
    { value: "202", label: "#202 Add billing retry", hint: "bob:billing-backoff" },
    { value: "303", label: "#303 Rename docs", hint: "cara:docs" },
  ];

  it("filters items from typed input and selects from the filtered list", () => {
    let state = pickerInit(items, 5);
    state = pickerKey(state, { kind: "input", text: "bill" });

    expect(state.query).toBe("bill");
    expect(state.items.map((item) => item.value)).toEqual(["202"]);

    state = pickerKey(state, "enter");
    expect(state.done).toEqual({ kind: "selected", value: "202" });
  });

  it("matches against hints as well as labels", () => {
    let state = pickerInit(items, 5);
    state = pickerKey(state, { kind: "input", text: "hydr" });

    expect(state.items.map((item) => item.value)).toEqual(["101"]);
  });

  it("backspace edits the query and clear-query resets the full list", () => {
    let state = pickerInit(items, 5);
    state = pickerKey(state, { kind: "input", text: "docs" });
    expect(state.items.map((item) => item.value)).toEqual(["303"]);

    state = pickerKey(state, "backspace");
    expect(state.query).toBe("doc");
    expect(state.items.map((item) => item.value)).toContain("303");

    state = pickerKey(state, "clear-query");
    expect(state.query).toBe("");
    expect(state.items).toEqual(items);
  });

  it("enter is ignored when a query has no matches", () => {
    let state = pickerInit(items, 5);
    state = pickerKey(state, { kind: "input", text: "zzzz" });
    expect(state.items).toEqual([]);

    state = pickerKey(state, "enter");
    expect(state.done).toBe(null);
  });
});

describe("pickerKey - done state immutability", () => {
  const items = [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ];

  it("returns state unchanged when already done (selected)", () => {
    let state = pickerInit(items, 2);
    state = pickerKey(state, "down");
    state = pickerKey(state, "enter");
    expect(state.cursor).toBe(1);
    const next = pickerKey(state, "up");
    expect(next.cursor).toBe(1);
    expect(next).toEqual(state);
  });

  it("returns state unchanged when already done (cancelled)", () => {
    let state = pickerInit(items, 2);
    state = pickerKey(state, "escape");
    const next = pickerKey(state, "down");
    expect(next.cursor).toBe(0);
    expect(next).toEqual(state);
  });

  it("all keys return unchanged state if done is set", () => {
    let state = pickerInit(items, 2);
    state = pickerKey(state, "escape");
    const keys: Array<"up" | "down" | "pageup" | "pagedown" | "home" | "end" | "enter" | "escape"> = [
      "up",
      "down",
      "pageup",
      "pagedown",
      "home",
      "end",
      "enter",
      "escape",
    ];
    for (const key of keys) {
      const result = pickerKey(state, key);
      expect(result).toEqual(state);
    }
  });
});

describe("decodeKey - all mappings", () => {
  it("decodes up arrow", () => {
    expect(decodeKey("\x1b[A")).toBe("up");
  });

  it("decodes down arrow", () => {
    expect(decodeKey("\x1b[B")).toBe("down");
  });

  it("decodes pageup", () => {
    expect(decodeKey("\x1b[5~")).toBe("pageup");
  });

  it("decodes pagedown", () => {
    expect(decodeKey("\x1b[6~")).toBe("pagedown");
  });

  it("decodes home (CSI H)", () => {
    expect(decodeKey("\x1b[H")).toBe("home");
  });

  it("decodes home (CSI 1~)", () => {
    expect(decodeKey("\x1b[1~")).toBe("home");
  });

  it("decodes end (CSI F)", () => {
    expect(decodeKey("\x1b[F")).toBe("end");
  });

  it("decodes end (CSI 4~)", () => {
    expect(decodeKey("\x1b[4~")).toBe("end");
  });

  it("decodes enter (carriage return)", () => {
    expect(decodeKey("\r")).toBe("enter");
  });

  it("decodes enter (newline)", () => {
    expect(decodeKey("\n")).toBe("enter");
  });

  it("decodes escape (ESC)", () => {
    expect(decodeKey("\x1b")).toBe("escape");
  });

  it("decodes escape (ctrl-c)", () => {
    expect(decodeKey("\x03")).toBe("escape");
  });

  it("decodes printable input for fuzzy filtering", () => {
    expect(decodeKey("x")).toEqual({ kind: "input", text: "x" });
    expect(decodeKey("billing")).toEqual({ kind: "input", text: "billing" });
    expect(decodeKey(" ")).toEqual({ kind: "input", text: " " });
  });

  it("decodes query-editing keys", () => {
    expect(decodeKey("\x7f")).toBe("backspace");
    expect(decodeKey("\b")).toBe("backspace");
    expect(decodeKey("\x15")).toBe("clear-query");
  });

  it("returns null for unrecognized keys", () => {
    expect(decodeKey("")).toBe(null);
    expect(decodeKey("\x1b[99~")).toBe(null);
  });
});

describe("picker fuzzy scoring", () => {
  it("scores subsequence matches and rejects non-matches", () => {
    expect(pickerFuzzyScore("fhm", "Fix hydration mismatch")).toBeTypeOf("number");
    expect(pickerFuzzyScore("zzz", "Fix hydration mismatch")).toBe(null);
  });

  it("ranks filtered items by fuzzy score", () => {
    const items = [
      { value: "1", label: "Alpha beta" },
      { value: "2", label: "Billing retry" },
      { value: "3", label: "Big refactor" },
    ];
    expect(pickerFilterItems(items, "bill").map((item) => item.value)).toEqual(["2"]);
  });
});

describe("pickerRender - basic", () => {
  const items = [
    { value: "1", label: "Item 1" },
    { value: "2", label: "Item 2" },
    { value: "3", label: "Item 3" },
  ];

  it("renders correct number of rows", () => {
    const state = pickerInit(items, 2);
    const rendered = pickerRender(state, 40);
    expect(rendered).toHaveLength(2);
  });

  it("prefixes cursor row with cursor marker", () => {
    const state = pickerInit(items, 2);
    const rendered = pickerRender(state, 40);
    expect(rendered[0]).toMatch(/^❯ /);
  });

  it("prefixes non-cursor rows with spaces", () => {
    const state = pickerInit(items, 2);
    const rendered = pickerRender(state, 40);
    expect(rendered[1]).toMatch(/^  /);
  });

  it("renders all visible items", () => {
    const state = pickerInit(items, 3);
    const rendered = pickerRender(state, 40);
    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toContain("Item 1");
    expect(rendered[1]).toContain("Item 2");
    expect(rendered[2]).toContain("Item 3");
  });

  it("renders the filter query and match count when filtering", () => {
    let state = pickerInit(items, 3);
    state = pickerKey(state, { kind: "input", text: "2" });
    const rendered = pickerRender(state, 40);
    expect(rendered[0]).toContain("filter:");
    expect(rendered[0]).toContain("2");
    expect(rendered[0]).toContain("(1/3)");
    expect(rendered[1]).toContain("Item 2");
  });

  it("renders a no-match row when the query filters everything", () => {
    let state = pickerInit(items, 3);
    state = pickerKey(state, { kind: "input", text: "zzz" });
    const rendered = pickerRender(state, 40);
    expect(rendered[0]).toContain("filter:");
    expect(rendered[1]).toContain("No matches");
  });
});

describe("pickerRender - scrolling window", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    value: `${i}`,
    label: `Item ${i}`,
  }));

  it("respects offset for first visible row", () => {
    let state = pickerInit(items, 2);
    state = pickerKey(state, "down");
    state = pickerKey(state, "down");
    state = pickerKey(state, "down"); // cursor=3, offset should follow
    const rendered = pickerRender(state, 40);
    expect(rendered[0]).toContain("Item 2");
    expect(rendered[1]).toContain("Item 3");
  });

  it("renders only height rows even with many items", () => {
    let state = pickerInit(items, 2);
    state = pickerKey(state, "down");
    state = pickerKey(state, "down");
    const rendered = pickerRender(state, 40);
    expect(rendered).toHaveLength(2);
  });

  it("renders fewer rows at end of list", () => {
    let state = pickerInit(items, 5);
    state = pickerKey(state, "end");
    const rendered = pickerRender(state, 40);
    expect(rendered.length).toBeLessThanOrEqual(5);
  });
});

describe("pickerRender - hints", () => {
  it("renders label without hint", () => {
    const items = [{ value: "a", label: "Item A" }];
    const state = pickerInit(items, 1);
    const rendered = pickerRender(state, 40);
    expect(rendered[0]).toContain("Item A");
  });

  it("renders label with hint in dim color", () => {
    const items = [{ value: "a", label: "Item A", hint: "draft" }];
    const state = pickerInit(items, 1);
    const rendered = pickerRender(state, 40);
    expect(rendered[0]).toContain("Item A");
    expect(rendered[0]).toContain("draft");
    expect(rendered[0]).toContain("\x1b[2m");
    expect(rendered[0]).toContain("\x1b[0m");
  });

  it("separates label and hint with space", () => {
    const items = [{ value: "a", label: "Item A", hint: "draft" }];
    const state = pickerInit(items, 1);
    const rendered = pickerRender(state, 40);
    expect(rendered[0]).toContain("Item A ");
  });
});

describe("pickerRender - truncation", () => {
  it("truncates label to width", () => {
    const items = [{ value: "a", label: "Very long item label" }];
    const state = pickerInit(items, 1);
    const rendered = pickerRender(state, 10);
    // "❯ " (2 chars) + 8 chars of label
    expect(rendered[0].length).toBeLessThanOrEqual(10);
  });

  it("accounts for prefix width in truncation", () => {
    const items = [{ value: "a", label: "12345678" }];
    const state = pickerInit(items, 1);
    const rendered = pickerRender(state, 5);
    // "❯ " (2 chars) + 3 chars of label = 5 chars total
    expect(rendered[0]).toBe("❯ 123");
  });

  it("handles very small width", () => {
    const items = [{ value: "a", label: "Item" }];
    const state = pickerInit(items, 1);
    const rendered = pickerRender(state, 2);
    expect(rendered[0].length).toBeLessThanOrEqual(2);
  });

  it("truncates with ANSI codes in hint", () => {
    const items = [{ value: "a", label: "Item", hint: "hint" }];
    const state = pickerInit(items, 1);
    const rendered = pickerRender(state, 8);
    // Width is 8, "❯ " is 2, so we have 6 chars for "Item " + hint with ANSI
    expect(rendered[0].length).toBeGreaterThan(8); // ANSI codes are included in string but not in visible width
  });
});

describe("pickerRender - cursor marker on correct row", () => {
  const items = [
    { value: "1", label: "Item 1" },
    { value: "2", label: "Item 2" },
    { value: "3", label: "Item 3" },
  ];

  it("marks first item as cursor when cursor is 0", () => {
    const state = pickerInit(items, 3);
    const rendered = pickerRender(state, 40);
    expect(rendered[0]).toMatch(/^❯ /);
    expect(rendered[1]).toMatch(/^  /);
    expect(rendered[2]).toMatch(/^  /);
  });

  it("marks second item as cursor when cursor is 1", () => {
    let state = pickerInit(items, 3);
    state = pickerKey(state, "down");
    const rendered = pickerRender(state, 40);
    expect(rendered[0]).toMatch(/^  /);
    expect(rendered[1]).toMatch(/^❯ /);
    expect(rendered[2]).toMatch(/^  /);
  });

  it("marks correct row when scrolled", () => {
    let state = pickerInit(items, 2);
    state = pickerKey(state, "down");
    state = pickerKey(state, "down");
    const rendered = pickerRender(state, 40);
    expect(rendered[0]).toMatch(/^  /); // Item 1 at offset 1, not cursor
    expect(rendered[1]).toMatch(/^❯ /); // Item 2 at offset 1, is cursor
  });
});

describe("pickerRender - edge cases", () => {
  it("renders single item", () => {
    const items = [{ value: "only", label: "Only Item" }];
    const state = pickerInit(items, 5);
    const rendered = pickerRender(state, 40);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain("Only Item");
  });

  it("renders with height=1", () => {
    const items = [
      { value: "1", label: "Item 1" },
      { value: "2", label: "Item 2" },
    ];
    const state = pickerInit(items, 1);
    const rendered = pickerRender(state, 40);
    expect(rendered).toHaveLength(1);
  });

  it("handles empty hint string", () => {
    const items = [{ value: "a", label: "Item", hint: "" }];
    const state = pickerInit(items, 1);
    const rendered = pickerRender(state, 40);
    expect(rendered[0]).toContain("Item");
  });

  it("renders unicode label", () => {
    const items = [{ value: "a", label: "Item 🎉" }];
    const state = pickerInit(items, 1);
    const rendered = pickerRender(state, 40);
    expect(rendered[0]).toContain("🎉");
  });
});
