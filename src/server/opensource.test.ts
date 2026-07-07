import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSourceOpener, type SourceOpenExec } from "./opensource.ts";

describe("createSourceOpener", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "sleek-open-source-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("uses SLEEK_OPEN_CMD with file and line placeholders first", async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const exec: SourceOpenExec = async (command, args) => {
      calls.push({ command, args });
    };
    const open = createSourceOpener(root, {
      exec,
      env: { SLEEK_OPEN_CMD: 'editor --goto "{file}:{line}"' },
      platform: "linux",
    });

    await expect(open("src/util.ts", 9)).resolves.toBe(true);
    expect(calls).toEqual([
      {
        command: "editor",
        args: ["--goto", `${path.join(root, "src/util.ts")}:9`],
      },
    ]);
  });

  it("falls back from code to macOS open", async () => {
    const calls: string[] = [];
    const exec: SourceOpenExec = async (command) => {
      calls.push(command);
      if (command === "code") throw new Error("not installed");
    };
    const open = createSourceOpener(root, {
      exec,
      env: {},
      platform: "darwin",
    });

    await expect(open("src/util.ts", 3)).resolves.toBe(true);
    expect(calls).toEqual(["code", "open"]);
  });

  it("rejects paths that escape the worktree", async () => {
    const exec = vi.fn<SourceOpenExec>(async () => {});
    const open = createSourceOpener(root, {
      exec,
      env: {},
      platform: "darwin",
    });

    await expect(open("../secret.ts", 1)).resolves.toBe(false);
    await expect(open(path.join(root, "..", "secret.ts"), 1)).resolves.toBe(
      false,
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns false when no opener works", async () => {
    const exec: SourceOpenExec = async () => {
      throw new Error("nope");
    };
    const open = createSourceOpener(root, {
      exec,
      env: {},
      platform: "linux",
    });

    await expect(open("src/util.ts", 1)).resolves.toBe(false);
  });

  it("SLEEK_OPEN_CMD with a spaced path passes the full path as one argument", async () => {
    // Create a root with a space in it so the path itself contains spaces.
    const spacedRoot = mkdtempSync(path.join(tmpdir(), "sleek open source "));
    mkdirSync(path.join(spacedRoot, "src"));
    writeFileSync(path.join(spacedRoot, "src", "util.ts"), "");

    const calls: { command: string; args: readonly string[] }[] = [];
    const exec: SourceOpenExec = async (command, args) => {
      calls.push({ command, args });
    };
    const open = createSourceOpener(spacedRoot, {
      exec,
      // Template: code -g {file}:{line} — after tokenization there are 3 tokens;
      // {file} is substituted within the third token, NOT split on spaces.
      env: { SLEEK_OPEN_CMD: "code -g {file}:{line}" },
      platform: "linux",
    });

    await expect(open("src/util.ts", 5)).resolves.toBe(true);

    const expectedFile = path.join(spacedRoot, "src", "util.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("code");
    // -g and {file}:{line} must be exactly two args; the path with spaces stays intact.
    expect(calls[0]!.args).toEqual(["-g", `${expectedFile}:5`]);
    // The file arg must NOT be split — it's a single string containing spaces.
    expect((calls[0]!.args[1] as string).includes(" ")).toBe(true);

    rmSync(spacedRoot, { recursive: true, force: true });
  });

  it("rejects symlinks pointing outside the worktree (symlink traversal)", async () => {
    // Create a secret file outside the root
    const secretPath = path.join(root, "..", "sleek-secret-" + Date.now() + ".txt");
    writeFileSync(secretPath, "SECRET");
    // Create a symlink inside root pointing to the secret
    const linkPath = path.join(root, "evil.ts");
    try {
      symlinkSync(secretPath, linkPath);
    } catch {
      // Symlink creation failed; skip this test.
      rmSync(secretPath, { force: true });
      return;
    }

    const calls: { command: string; args: readonly string[] }[] = [];
    const exec: SourceOpenExec = async (command, args) => {
      calls.push({ command, args });
    };
    const open = createSourceOpener(root, {
      exec,
      env: {},
      platform: "linux",
    });

    // The symlink resolves outside the root — opener must return false without calling exec.
    await expect(open("evil.ts", 1)).resolves.toBe(false);
    expect(calls).toHaveLength(0);

    rmSync(secretPath, { force: true });
  });
});
