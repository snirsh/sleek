/**
 * Pure helpers for the Wave-7 in-app model choice UI — the Assistant model
 * dropdown next to the #chat-model status and the Scaffolder picker modal's
 * radio list. The server exposes GET /api/models (see work/wave7-contract.md);
 * these helpers turn its payload into display models the client renders, and
 * decide when the Process-PR affordance appears.
 *
 * SHIPPING MODEL (same as versionsui.ts / threadsui.ts / markdown.ts): these
 * exact functions also run in the browser — client.ts injects each
 * fn.toString() into CLIENT_JS, so every body must stay fully self-contained:
 * no imports, no references to module scope, no TS-only runtime syntax, and NO
 * backticks or ${} (client code is string-concat only). modelsui.test.ts covers
 * the very functions the page runs. (The type-only shapes below are erased.)
 */

/** GET /api/models → .scaffolder (client's view). */
export interface ScaffolderModels {
  available: boolean;
  anthropic: boolean;
  replay: boolean;
  chosen: string | null;
  /** Human-readable provider label; omitted when not supplied by the server. */
  providerLabel?: string;
  /** Frozen contract (Slice C): server-resolved model list with group + dedup. */
  models: { id: string; label: string; group: string; available: boolean; reason?: string }[];
}

/** GET /api/models → .assistant (client's view). */
export interface AssistantModels {
  current: string;
  models: string[];
}

/** One radio row (or group header) of the Scaffolder picker. */
export interface ScaffolderRadio {
  /** POST /api/scaffold value: "replay" or a model id. Header rows: same as their group name. */
  value: string;
  /** Human label ("Replay authored review", "Opus", …). Header rows: the group name. */
  label: string;
  /** Disabled rows can't be selected; hint explains why. */
  disabled: boolean;
  /** Short reason shown next to a disabled row (empty when enabled). */
  hint: string;
  /** Pre-checked row (at most one true). Never true for headers. */
  checked: boolean;
  /** Provider group name this row belongs to (e.g. "Claude Code CLI"). */
  group: string;
  /** True for synthetic group-header separator rows (no radio input rendered). */
  isHeader?: boolean;
}

/** One <option> of the Assistant model dropdown. */
export interface AssistantOption {
  value: string;
  label: string;
  selected: boolean;
}

/**
 * The Process-PR button shows only when the page is LIVE, the server can
 * scaffold, and the served scaffold is empty (explore-first). Static file://
 * pages pass live=false, so the button never appears there.
 */
export function processButtonVisible(
  live: boolean,
  scaffoldAvailable: boolean,
  layerCount: number,
): boolean {
  return live === true && scaffoldAvailable === true && layerCount === 0;
}

/**
 * The Scaffolder picker's radio rows, data-driven over s.models (frozen
 * contract). The server has already resolved availability, grouping, and
 * deduplication. Groups arrive in order; a synthetic header row (isHeader:true)
 * is emitted whenever the group changes. Replay, when present, is prepended
 * as its own "Replay" group row.
 *
 * Exactly one enabled non-header row is pre-checked: the persisted s.chosen
 * when it is enabled, otherwise the first enabled non-header row. Returns []
 * when s.models is empty and replay is false. No provider inference or
 * providerLabel relabeling is performed — the server owns that logic.
 */
export function scaffolderRadioOptions(s: ScaffolderModels): ScaffolderRadio[] {
  // The server list (s.models) is the single source of grouped choices — including
  // the Replay row when available. No client-side prepend (that caused a duplicate
  // "Replay" header). Group headers are synthesized as the group changes.
  var rows = [];
  var lastGroup = "";
  for (var i = 0; i < s.models.length; i++) {
    var m = s.models[i];
    var grp = m.group || "";
    if (grp !== lastGroup) {
      rows.push({
        value: grp,
        label: grp,
        disabled: true,
        hint: "",
        checked: false,
        group: grp,
        isHeader: true,
      });
      lastGroup = grp;
    }
    var isAvailable = m.available === true;
    var hint = isAvailable ? "" : (m.reason || "not available");
    rows.push({
      value: m.id,
      label: m.label,
      disabled: !isAvailable,
      hint: hint,
      checked: false,
      group: grp,
    });
  }
  var enabled = rows.filter(function(r) { return !r.disabled && !r.isHeader; });
  if (!enabled.length) return rows;
  var chosenRow = s.chosen !== null ? enabled.find(function(r) { return r.value === s.chosen; }) : undefined;
  (chosenRow || enabled[0]).checked = true;
  return rows;
}

/**
 * The Assistant dropdown options: one per installed Ollama tag, with `current`
 * marked selected. When `current` isn't in the installed list (e.g. a stale
 * persisted choice) it is still listed and selected so the display stays
 * honest. Returns [] when no tags are installed (the dropdown is hidden then).
 */
export function assistantModelOptions(a: AssistantModels): AssistantOption[] {
  const opts: AssistantOption[] = a.models.map((m) => ({
    value: m,
    label: m,
    selected: m === a.current,
  }));
  if (a.current && !a.models.some((m) => m === a.current)) {
    opts.unshift({ value: a.current, label: a.current, selected: true });
  }
  return opts;
}
