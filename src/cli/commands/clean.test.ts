import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockedTmpdir = vi.hoisted(() => ({ path: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    tmpdir: () => mockedTmpdir.path,
  };
});

import { runClean } from "./clean.ts";

let root: string;
let repo: string;
let stdout = "";
let stderr = "";

function writeSpy(stream: NodeJS.WriteStream, sink: (chunk: string) => void) {
  return vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => {
    sink(String(chunk));
    return true;
  });
}

function makeRepo(): void {
  mkdirSync(join(repo, ".sleek"), { recursive: true });
}

function makeOldDir(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "file.txt"), "old");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(path, old, old);
}

beforeEach(() => {
  root = mkdtempSync(join("/tmp", "sleek-clean-test-"));
  repo = join(root, "repo");
  mockedTmpdir.path = join(root, "tmp");
  mkdirSync(mockedTmpdir.path, { recursive: true });
  stdout = "";
  stderr = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("runClean", () => {
  it("defaults to dry-run and deletes nothing without --yes", async () => {
    makeRepo();
    const cacheDb = join(repo, ".sleek", "cache.db");
    const worktree = join(mockedTmpdir.path, "sleek-wt-old");
    writeFileSync(cacheDb, "cache");
    makeOldDir(worktree);
    writeSpy(process.stdout, (chunk) => { stdout += chunk; });
    writeSpy(process.stderr, (chunk) => { stderr += chunk; });

    await runClean({ repo, yes: false });

    expect(existsSync(cacheDb)).toBe(true);
    expect(existsSync(worktree)).toBe(true);
    expect(stdout).toContain("What would be removed:");
    expect(stdout).toContain("Dry run");
    expect(stderr).toBe("");
  });

  it("never deletes demo.db or entries outside its target prefixes", async () => {
    makeRepo();
    const cacheDb = join(repo, ".sleek", "cache.db");
    const demoDb = join(repo, ".sleek", "demo.db");
    const unrelatedDb = join(repo, ".sleek", "notes.db");
    const unrelatedTmpDir = join(mockedTmpdir.path, "other-wt-old");
    writeFileSync(cacheDb, "cache");
    writeFileSync(demoDb, "demo");
    writeFileSync(unrelatedDb, "notes");
    makeOldDir(unrelatedTmpDir);
    writeSpy(process.stdout, (chunk) => { stdout += chunk; });
    writeSpy(process.stderr, (chunk) => { stderr += chunk; });

    await runClean({ repo, yes: true });

    expect(existsSync(cacheDb)).toBe(false);
    expect(existsSync(demoDb)).toBe(true);
    expect(existsSync(unrelatedDb)).toBe(true);
    expect(existsSync(unrelatedTmpDir)).toBe(true);
    expect(stdout).toContain("Refusing to touch demo.db");
    expect(stderr).toBe("");
  });

  it("skips worktrees younger than 1 hour", async () => {
    makeRepo();
    const worktree = join(mockedTmpdir.path, "sleek-wt-fresh");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "file.txt"), "fresh");
    const before = statSync(worktree).mtimeMs;
    writeSpy(process.stdout, (chunk) => { stdout += chunk; });
    writeSpy(process.stderr, (chunk) => { stderr += chunk; });

    await runClean({ repo, yes: true });

    expect(existsSync(worktree)).toBe(true);
    expect(statSync(worktree).mtimeMs).toBe(before);
    expect(stdout).toContain("Skipping (modified < 1h ago, possibly in use):");
    expect(stderr).toBe("");
  });

  it("deletes eligible entries with --yes", async () => {
    makeRepo();
    const cacheDb = join(repo, ".sleek", "cache.db");
    const worktree = join(mockedTmpdir.path, "sleek-wt-old");
    writeFileSync(cacheDb, "cache");
    makeOldDir(worktree);
    writeSpy(process.stdout, (chunk) => { stdout += chunk; });
    writeSpy(process.stderr, (chunk) => { stderr += chunk; });

    await runClean({ repo, yes: true });

    expect(existsSync(cacheDb)).toBe(false);
    expect(existsSync(worktree)).toBe(false);
    expect(stdout).toContain("Deleted: " + cacheDb);
    expect(stdout).toContain("Deleted: " + worktree);
    expect(stderr).toBe("");
  });
});
