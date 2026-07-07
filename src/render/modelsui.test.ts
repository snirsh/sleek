import { describe, expect, it } from "vitest";

import {
  assistantModelOptions,
  processButtonVisible,
  scaffolderRadioOptions,
} from "./modelsui.ts";
import type { AssistantModels, ScaffolderModels } from "./modelsui.ts";

// Frozen contract shape: server sends group + available + optional reason.
const MODELS_CLI: ScaffolderModels["models"] = [
  { id: "claude:fable5", label: "Fable 5", group: "Claude Code CLI", available: true },
  { id: "claude:opus4.8", label: "Opus 4.8", group: "Claude Code CLI", available: true },
  { id: "claude:sonnet4.6", label: "Sonnet 4.6", group: "Claude Code CLI", available: true },
];

const MODELS_MULTI: ScaffolderModels["models"] = [
  { id: "claude:opus4.8", label: "Opus 4.8", group: "Claude Code CLI", available: true },
  { id: "claude:opus-unavailable", label: "Opus unavailable", group: "Claude Code CLI", available: false, reason: "binary not found" },
  { id: "codex", label: "Codex (config default)", group: "Codex", available: true },
  { id: "replay", label: "Replay authored review", group: "Replay", available: true },
];

describe("processButtonVisible", () => {
  it("shows only when live, scaffold available, and zero layers", () => {
    expect(processButtonVisible(true, true, 0)).toBe(true);
  });
  it("hides on a scaffolded page (layers present)", () => {
    expect(processButtonVisible(true, true, 4)).toBe(false);
  });
  it("hides when the server can't scaffold", () => {
    expect(processButtonVisible(true, false, 0)).toBe(false);
  });
  it("hides in static mode (not live)", () => {
    expect(processButtonVisible(false, true, 0)).toBe(false);
  });
});

describe("scaffolderRadioOptions — new frozen-contract shape", () => {
  it("returns [] when models is empty and replay is false", () => {
    const s: ScaffolderModels = {
      available: false,
      anthropic: false,
      replay: false,
      chosen: null,
      models: [],
    };
    expect(scaffolderRadioOptions(s)).toEqual([]);
  });

  it("emits a header row per group, in order", () => {
    const s: ScaffolderModels = {
      available: true,
      anthropic: false,
      replay: false,
      chosen: null,
      models: MODELS_MULTI,
    };
    const rows = scaffolderRadioOptions(s);
    const headers = rows.filter((r) => r.isHeader);
    expect(headers.map((h) => h.group)).toEqual(["Claude Code CLI", "Codex", "Replay"]);
  });

  it("emits exactly one header per group (no duplicates)", () => {
    const s: ScaffolderModels = {
      available: true,
      anthropic: false,
      replay: false,
      chosen: null,
      models: MODELS_CLI, // all same group
    };
    const rows = scaffolderRadioOptions(s);
    const headers = rows.filter((r) => r.isHeader);
    expect(headers).toHaveLength(1);
    expect(headers[0].group).toBe("Claude Code CLI");
  });

  it("produces no duplicate value ids given a deduplicated server input", () => {
    const s: ScaffolderModels = {
      available: true,
      anthropic: false,
      replay: false,
      chosen: null,
      models: MODELS_MULTI,
    };
    const rows = scaffolderRadioOptions(s).filter((r) => !r.isHeader);
    const ids = rows.map((r) => r.value);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it("disabled rows are shown with their reason hint and never pre-checked", () => {
    const s: ScaffolderModels = {
      available: true,
      anthropic: false,
      replay: false,
      chosen: null,
      models: [
        { id: "claude:opus-unavailable", label: "Opus unavailable", group: "Claude Code CLI", available: false, reason: "binary not found" },
      ],
    };
    const rows = scaffolderRadioOptions(s);
    const model = rows.find((r) => r.value === "claude:opus-unavailable");
    expect(model).toBeDefined();
    expect(model!.disabled).toBe(true);
    expect(model!.hint).toBe("binary not found");
    expect(model!.checked).toBe(false);
  });

  it("disabled rows without reason get a fallback hint", () => {
    const s: ScaffolderModels = {
      available: true,
      anthropic: false,
      replay: false,
      chosen: null,
      models: [
        { id: "someid", label: "Some Model", group: "Codex", available: false },
      ],
    };
    const rows = scaffolderRadioOptions(s);
    const model = rows.find((r) => r.value === "someid");
    expect(model!.hint).toBe("not available");
  });

  it("exactly one enabled non-header row is pre-checked", () => {
    const s: ScaffolderModels = {
      available: true,
      anthropic: false,
      replay: false,
      chosen: null,
      models: MODELS_MULTI,
    };
    const rows = scaffolderRadioOptions(s);
    const checked = rows.filter((r) => r.checked && !r.isHeader);
    expect(checked).toHaveLength(1);
  });

  it("pre-checks chosen when it is present and enabled", () => {
    const s: ScaffolderModels = {
      available: true,
      anthropic: false,
      replay: false,
      chosen: "codex",
      models: MODELS_MULTI,
    };
    const rows = scaffolderRadioOptions(s);
    const checked = rows.filter((r) => r.checked && !r.isHeader);
    expect(checked).toHaveLength(1);
    expect(checked[0].value).toBe("codex");
  });

  it("falls back to first enabled non-header row when chosen is disabled", () => {
    const s: ScaffolderModels = {
      available: true,
      anthropic: false,
      replay: false,
      chosen: "claude:opus-unavailable", // disabled
      models: MODELS_MULTI,
    };
    const rows = scaffolderRadioOptions(s);
    const checked = rows.filter((r) => r.checked && !r.isHeader);
    expect(checked).toHaveLength(1);
    // First enabled non-header is opus
    expect(checked[0].value).toBe("claude:opus4.8");
  });

  it("headers are never pre-checked", () => {
    const s: ScaffolderModels = {
      available: true,
      anthropic: false,
      replay: false,
      chosen: null,
      models: MODELS_MULTI,
    };
    const rows = scaffolderRadioOptions(s);
    const checkedHeaders = rows.filter((r) => r.isHeader && r.checked);
    expect(checkedHeaders).toHaveLength(0);
  });

  it("checks nothing when all rows are disabled", () => {
    const s: ScaffolderModels = {
      available: false,
      anthropic: false,
      replay: false,
      chosen: null,
      models: [
        { id: "claude:opus-unavailable", label: "Opus unavailable", group: "Claude Code CLI", available: false, reason: "binary not found" },
      ],
    };
    const rows = scaffolderRadioOptions(s);
    expect(rows.some((r) => r.checked)).toBe(false);
  });

  // The server list (s.models) owns the Replay row — it leads the list. The client
  // renders one "Replay" header from it and never prepends its own (that caused a
  // duplicate header).
  const MODELS_WITH_REPLAY: ScaffolderModels["models"] = [
    { id: "replay", label: "Replay authored review", group: "Replay", available: true },
    ...MODELS_CLI,
  ];

  it("renders exactly one Replay group header from the server list (no duplicate)", () => {
    const s: ScaffolderModels = {
      available: true,
      anthropic: false,
      replay: true,
      chosen: null,
      models: MODELS_WITH_REPLAY,
    };
    const rows = scaffolderRadioOptions(s);
    const replayHeaders = rows.filter((r) => r.isHeader && r.group === "Replay");
    expect(replayHeaders).toHaveLength(1);
    // Leading group is Replay, then the CLI group.
    expect(rows[0].isHeader).toBe(true);
    expect(rows[0].group).toBe("Replay");
    expect(rows[1].value).toBe("replay");
    expect(rows[1].isHeader).toBeFalsy();
    expect(rows[2].isHeader).toBe(true);
    expect(rows[2].group).toBe("Claude Code CLI");
  });

  it("pre-checks the leading replay row when no chosen", () => {
    const s: ScaffolderModels = {
      available: true,
      anthropic: false,
      replay: true,
      chosen: null,
      models: MODELS_WITH_REPLAY,
    };
    const rows = scaffolderRadioOptions(s);
    const checked = rows.filter((r) => r.checked && !r.isHeader);
    expect(checked).toHaveLength(1);
    expect(checked[0].value).toBe("replay");
  });

  it("chosen=replay is honored", () => {
    const s: ScaffolderModels = {
      available: true,
      anthropic: false,
      replay: true,
      chosen: "replay",
      models: MODELS_WITH_REPLAY,
    };
    const rows = scaffolderRadioOptions(s);
    const checked = rows.filter((r) => r.checked && !r.isHeader);
    expect(checked).toHaveLength(1);
    expect(checked[0].value).toBe("replay");
  });

  it("chosen can be a non-replay model id, bypassing replay", () => {
    const s: ScaffolderModels = {
      available: true,
      anthropic: false,
      replay: true,
      chosen: "claude:sonnet4.6",
      models: MODELS_CLI,
    };
    const rows = scaffolderRadioOptions(s);
    const checked = rows.filter((r) => r.checked && !r.isHeader);
    expect(checked).toHaveLength(1);
    expect(checked[0].value).toBe("claude:sonnet4.6");
  });

  it("label comes directly from m.label with no suffix added", () => {
    const s: ScaffolderModels = {
      available: true,
      anthropic: false,
      replay: false,
      chosen: null,
      providerLabel: "Claude Code CLI", // must be ignored
      models: [
        { id: "claude:opus4.8", label: "Opus 4.8", group: "Claude Code CLI", available: true },
      ],
    };
    const rows = scaffolderRadioOptions(s);
    const model = rows.find((r) => r.value === "claude:opus4.8");
    expect(model!.label).toBe("Opus 4.8");
  });

  it("groups appear in the order the server sends them", () => {
    // Server sends Codex before Claude Code CLI — we preserve that
    const s: ScaffolderModels = {
      available: true,
      anthropic: false,
      replay: false,
      chosen: null,
      models: [
        { id: "codex:gpt-5.5", label: "GPT-5.5", group: "Codex", available: true },
        { id: "claude:opus4.8", label: "Opus 4.8", group: "Claude Code CLI", available: true },
      ],
    };
    const rows = scaffolderRadioOptions(s);
    const headers = rows.filter((r) => r.isHeader);
    expect(headers.map((h) => h.group)).toEqual(["Codex", "Claude Code CLI"]);
  });
});

describe("assistantModelOptions", () => {
  it("lists installed tags with current selected", () => {
    const a: AssistantModels = {
      current: "qwen3.6:latest",
      models: ["qwen3.6:latest", "qwen2.5-coder:32b"],
    };
    const opts = assistantModelOptions(a);
    expect(opts.map((o) => o.value)).toEqual(["qwen3.6:latest", "qwen2.5-coder:32b"]);
    expect(opts.filter((o) => o.selected).map((o) => o.value)).toEqual(["qwen3.6:latest"]);
  });

  it("prepends and selects a current tag missing from the installed list", () => {
    const a: AssistantModels = {
      current: "custom:latest",
      models: ["qwen3.6:latest"],
    };
    const opts = assistantModelOptions(a);
    expect(opts.map((o) => o.value)).toEqual(["custom:latest", "qwen3.6:latest"]);
    expect(opts[0].selected).toBe(true);
    expect(opts.filter((o) => o.selected)).toHaveLength(1);
  });

  it("returns [] when no tags are installed", () => {
    expect(assistantModelOptions({ current: "", models: [] })).toEqual([]);
  });
});

describe("client-shipping contract", () => {
  it("ships to the client backtick-free (fn.toString contract)", () => {
    for (const fn of [scaffolderRadioOptions, assistantModelOptions, processButtonVisible]) {
      const src = fn.toString();
      expect(src.includes("`"), fn.name + " has a backtick").toBe(false);
      expect(src.includes("${"), fn.name + " has ${").toBe(false);
    }
  });
});
