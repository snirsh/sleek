import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { withWorktree } from "./worktree.ts";
import { regionHistory } from "./history.ts";

// ---------------------------------------------------------------------------
// Fetch-fallback test setup: bare origin + two clones.
//
// Topology:
//   originRepo (bare)  ←—  clone1 (has commit A only; plays the role of the
//                          Sleek working clone that hasn't fetched yet)
//               ↑
//           clone2 (adds commit B to origin via push)
//
// withWorktree on clone1 with the SHA of commit B must succeed via the fetch
// fallback; a garbage SHA must still throw.
// ---------------------------------------------------------------------------
let originRepo: string;
let clone1Path: string;
let clone2Path: string;
let unfetchedSha: string;

beforeAll(async () => {
  originRepo = await mkdtemp(join(tmpdir(), "sleek-test-origin-"));
  clone1Path = await mkdtemp(join(tmpdir(), "sleek-test-clone1-"));
  clone2Path = await mkdtemp(join(tmpdir(), "sleek-test-clone2-"));

  // Create bare origin repo with an initial commit.
  const originGit = simpleGit(originRepo);
  await originGit.init(["--bare"]);

  // Create clone2 (will push the new commit).
  await simpleGit().clone(originRepo, clone2Path, ["--no-local"]);
  const git2 = simpleGit(clone2Path);
  await git2.addConfig("user.email", "test@example.com");
  await git2.addConfig("user.name", "Test");
  await git2.addConfig("commit.gpgsign", "false");

  // Initial commit on clone2, push to origin.
  const fileA = join(clone2Path, "a.ts");
  await writeFile(fileA, "export const a = 1;\n");
  await git2.add("a.ts");
  await git2.commit("initial commit");
  await git2.push("origin", "main");

  // Clone1 starts from this state (has the initial commit).
  await simpleGit().clone(originRepo, clone1Path, ["--no-local"]);

  // Now clone2 adds a NEW commit and pushes it to origin — clone1 hasn't fetched yet.
  const fileB = join(clone2Path, "b.ts");
  await writeFile(fileB, "export const b = 2;\n");
  await git2.add("b.ts");
  await git2.commit("add b");
  await git2.push("origin", "main");

  unfetchedSha = (await git2.revparse(["HEAD"])).trim();
}, 30_000);

afterAll(async () => {
  await Promise.all([
    rm(originRepo, { recursive: true, force: true }),
    rm(clone1Path, { recursive: true, force: true }),
    rm(clone2Path, { recursive: true, force: true }),
  ]);
});

describe("withWorktree fetch fallback", () => {
  it("succeeds via fetch fallback when the sha is not locally available", async () => {
    // clone1 does not have unfetchedSha yet; withWorktree should fetch and succeed.
    const contents = await withWorktree(
      clone1Path,
      unfetchedSha,
      async (wt) => readFile(join(wt, "b.ts"), "utf8"),
      { fetchRefs: ["main"] },
    );
    expect(contents).toContain("export const b = 2;");
  });

  it("throws a descriptive error when the sha is garbage and all fetches fail", async () => {
    const garbageSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    await expect(
      withWorktree(
        clone1Path,
        garbageSha,
        async () => "should not reach",
        { fetchRefs: ["pull/99/head"] },
      ),
    ).rejects.toThrow(garbageSha);
  });

  it("cleans up the worktree directory even after a fetch fallback succeeds", async () => {
    let seenPath = "";
    await withWorktree(
      clone1Path,
      unfetchedSha,
      async (wt) => {
        seenPath = wt;
      },
      { fetchRefs: ["main"] },
    );
    await expect(readFile(join(seenPath, "b.ts"), "utf8")).rejects.toThrow();
  });
});

// Integration: build a throwaway git repo, then exercise the real worktree lifecycle
// and line-range history against it.
let repoPath: string;
let headSha: string;

beforeAll(async () => {
  repoPath = await mkdtemp(join(tmpdir(), "sleek-test-repo-"));
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  await git.addConfig("commit.gpgsign", "false");

  const file = join(repoPath, "sample.ts");
  await writeFile(file, "export const a = 1;\nexport const b = 2;\n");
  await git.add("sample.ts");
  await git.commit("initial commit");

  await writeFile(file, "export const a = 10;\nexport const b = 2;\nexport const c = 3;\n");
  await git.add("sample.ts");
  await git.commit("bump a and add c");

  headSha = (await git.revparse(["HEAD"])).trim();
}, 30_000);

afterAll(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

describe("withWorktree", () => {
  it("checks out the sha in a temp dir and cleans up afterwards", async () => {
    let seenPath = "";
    const contents = await withWorktree(repoPath, headSha, async (wt) => {
      seenPath = wt;
      return readFile(join(wt, "sample.ts"), "utf8");
    });
    expect(contents).toContain("export const c = 3;");
    // Worktree dir removed on exit.
    await expect(readFile(join(seenPath, "sample.ts"), "utf8")).rejects.toThrow();
    // The user's clone is not left with a registered worktree.
    const list = await simpleGit(repoPath).raw(["worktree", "list", "--porcelain"]);
    expect(list).not.toContain(seenPath);
  });

  it("cleans up even when fn throws", async () => {
    let seenPath = "";
    await expect(
      withWorktree(repoPath, headSha, async (wt) => {
        seenPath = wt;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(readFile(join(seenPath, "sample.ts"), "utf8")).rejects.toThrow();
  });

  it("never touches the user's checkout or branch", async () => {
    const git = simpleGit(repoPath);
    const branchBefore = (await git.raw(["symbolic-ref", "--short", "HEAD"])).trim();
    const statusBefore = await git.status();
    await withWorktree(repoPath, headSha, async () => "noop");
    const branchAfter = (await git.raw(["symbolic-ref", "--short", "HEAD"])).trim();
    const statusAfter = await git.status();
    expect(branchAfter).toBe(branchBefore);
    expect(statusAfter.isClean()).toBe(statusBefore.isClean());
  });
});

describe("regionHistory (real repo through a worktree)", () => {
  it("returns commits that touched the given lines, newest first", async () => {
    const entries = await withWorktree(repoPath, headSha, (wt) =>
      regionHistory(wt, "sample.ts", 1, 1),
    );
    // Line 1 (`export const a`) was changed by both commits.
    const subjects = entries.map((e) => e.subject);
    expect(subjects).toContain("bump a and add c");
    expect(entries[0]?.subject).toBe("bump a and add c");
    expect(entries[0]?.sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(entries[0]?.whenRelevant).not.toBe("");
  });
});
