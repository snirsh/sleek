/**
 * Represents an item in the picker list.
 */
export interface PickerItem {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Represents the state of the picker, including items, cursor position,
 * scroll offset, visible height, and completion status.
 */
export interface PickerState {
  readonly allItems: readonly PickerItem[];
  readonly items: readonly PickerItem[];
  readonly query: string;
  readonly cursor: number;       // index into items
  readonly offset: number;       // first visible row (scrolling window)
  readonly height: number;       // max visible rows (>=1)
  readonly done: null | { kind: "selected"; value: string } | { kind: "cancelled" };
}

/**
 * Represents valid keys that can be processed by the picker.
 */
export type PickerKey =
  | "up"
  | "down"
  | "pageup"
  | "pagedown"
  | "home"
  | "end"
  | "enter"
  | "escape"
  | "backspace"
  | "clear-query"
  | { kind: "input"; text: string };

/**
 * Initializes the picker state with the given items and height.
 * If items are empty, sets the state to cancelled.
 *
 * @param items - The list of PickerItem objects.
 * @param height - The maximum number of visible rows in the picker.
 * @returns The initial PickerState.
 */
export function pickerInit(items: readonly PickerItem[], height: number): PickerState {
  if (items.length === 0) {
    return { allItems: items, items, query: "", cursor: 0, offset: 0, height, done: { kind: "cancelled" } };
  }
  return { allItems: items, items, query: "", cursor: 0, offset: 0, height, done: null };
}

/**
 * Calculates the new scroll offset to ensure the cursor is visible.
 *
 * @param state - The current PickerState.
 * @returns The adjusted offset.
 */
function calculateOffset({ cursor, offset, height, items }: PickerState): number {
  if (cursor < offset) {
    return cursor;
  }
  if (cursor >= offset + height) {
    return Math.min(cursor - height + 1, items.length - height);
  }
  return offset;
}

/**
 * Score `query` as a case-insensitive subsequence of `text`; null when absent.
 * Ranking favors contiguous and word-boundary matches, with a small length penalty.
 */
export function pickerFuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  let score = 0;
  let from = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const at = t.indexOf(q.charAt(qi), from);
    if (at === -1) return null;
    score += 1;
    if (at === prev + 1) score += 2;
    else if (at === 0 || !/[a-z0-9]/.test(t.charAt(at - 1))) score += 1;
    prev = at;
    from = at + 1;
  }
  return score - t.length / 1000;
}

function itemSearchText(item: PickerItem): string {
  return `${item.label} ${item.hint ?? ""} ${item.value}`;
}

export function pickerFilterItems(
  items: readonly PickerItem[],
  query: string,
): PickerItem[] {
  if (query === "") return [...items];
  const scored: { item: PickerItem; score: number; index: number }[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const score = pickerFuzzyScore(query, itemSearchText(item));
    if (score !== null) scored.push({ item, score, index });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.item);
}

function updateQuery(state: PickerState, query: string): PickerState {
  const items = pickerFilterItems(state.allItems, query);
  return {
    ...state,
    items,
    query,
    cursor: 0,
    offset: 0,
    done: items.length === 0 ? null : state.done,
  };
}

/**
 * Updates the picker state based on the key pressed.
 *
 * @param state - The current PickerState.
 * @param key - The key that was pressed.
 * @returns The new PickerState after processing the key.
 */
export function pickerKey(state: PickerState, key: PickerKey): PickerState {
  const { items, cursor, height } = state;

  if (state.done !== null) {
    return state;
  }

  let newCursor = cursor;
  switch (key) {
    case "backspace":
      return state.query === "" ? state : updateQuery(state, state.query.slice(0, -1));
    case "clear-query":
      return state.query === "" ? state : updateQuery(state, "");
    case "up":
      newCursor = Math.max(0, cursor - 1);
      break;
    case "down":
      newCursor = Math.min(items.length - 1, cursor + 1);
      break;
    case "pageup":
      newCursor = Math.max(0, cursor - height);
      break;
    case "pagedown":
      newCursor = Math.min(items.length - 1, cursor + height);
      break;
    case "home":
      newCursor = 0;
      break;
    case "end":
      newCursor = items.length - 1;
      break;
    case "enter":
      if (items.length === 0) return state;
      return { ...state, done: { kind: "selected", value: items[cursor].value } };
    case "escape":
      return { ...state, done: { kind: "cancelled" } };
    default:
      return updateQuery(state, state.query + key.text);
  }

  const newOffset = calculateOffset({ ...state, cursor: newCursor });
  return { ...state, cursor: newCursor, offset: newOffset };
}

/**
 * Decodes a raw key input into a PickerKey or null.
 *
 * @param chunk - The raw string input from the keyboard.
 * @returns The corresponding PickerKey or null if not recognized.
 */
export function decodeKey(chunk: string): PickerKey | null {
  switch (chunk) {
    case "\x1b[A":
      return "up";
    case "\x1b[B":
      return "down";
    case "\x1b[5~":
      return "pageup";
    case "\x1b[6~":
      return "pagedown";
    case "\x1b[H":
    case "\x1b[1~":
      return "home";
    case "\x1b[F":
    case "\x1b[4~":
      return "end";
    case "\r":
    case "\n":
      return "enter";
    case "\x1b":
    case "\x03":
      return "escape";
    case "\x7f":
    case "\b":
      return "backspace";
    case "\x15":
      return "clear-query";
    default:
      if (chunk.startsWith("\x1b")) return null;
      if (/^[ -~]+$/.test(chunk)) return { kind: "input", text: chunk };
      return null;
  }
}

/**
 * Renders the picker state into an array of strings, each representing a row.
 *
 * @param state - The current PickerState.
 * @param width - The maximum width for rendering each row.
 * @returns An array of strings representing the visible rows in the picker.
 */
export function pickerRender(state: PickerState, width: number): string[] {
  const { items, cursor, offset, height } = state;
  const dimStart = "\x1b[2m";
  const dimEnd = "\x1b[0m";
  const lines: string[] = [];

  if (state.query !== "") {
    lines.push(`${dimStart}filter: ${dimEnd}${state.query}${dimStart} (${items.length}/${state.allItems.length})${dimEnd}`);
  }

  if (items.length === 0) {
    lines.push(`${dimStart}  No matches${dimEnd}`);
    return lines;
  }

  lines.push(...items.slice(offset, Math.min(offset + height, items.length)).map((item, index) => {
    const isCursorRow = (offset + index) === cursor;
    const prefix = isCursorRow ? "❯ " : "  ";
    let label = item.label;
    if (item.hint) {
      label += ` ${dimStart}${item.hint}${dimEnd}`;
    }

    // Truncate the string to fit within the specified width
    let visibleWidth = width - prefix.length; // Account for the prefix length
    let truncatedLabel = "";
    let i = 0;
    while (i < label.length && visibleWidth > 0) {
      const char = label[i];
      if (char === "\x1b") { // Skip ANSI escape sequence
        const end = label.indexOf("m", i + 2);
        if (end !== -1) {
          truncatedLabel += label.substring(i, end + 1);
          i = end + 1;
        } else {
          break; // Malformed escape sequence, stop truncating
        }
      } else {
        truncatedLabel += char;
        visibleWidth -= 1;
        i += 1;
      }
    }

    return prefix + truncatedLabel;
  }));

  return lines;
}
