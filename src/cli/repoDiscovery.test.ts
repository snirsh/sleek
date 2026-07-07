import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GitRunner } from "../ingest/ingest.ts";
import {
  cloneGithubRepo,
  cloneRepoPickerItem,
  defaultRepoSearchRoots,
  discoverLocalGithubRepos,
  formatRepoList,
  parseGithubCloneTarget,
  reposToPickerItems,
} from "./repoDiscovery.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join("/tmp", "sleek-repos-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRepo(name: string): string {
  const repo = join(root, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

describe("repo discovery", () => {
  it("discovers local repos with github.com origin remotes", async () => {
    const alpha = makeRepo("alpha");
    const beta = makeRepo("beta");
    const other = makeRepo("other");

    const remotes = new Map([
      [alpha, "git@github.com:acme/alpha.git\n"],
      [beta, "https://github.com/acme/beta.git\n"],
      [other, "https://example.com/acme/other.git\n"],
    ]);
    const git: GitRunner = async (args, cwd) => {
      if (args.join(" ") === "remote get-url origin") {
        const remote = remotes.get(cwd);
        if (!remote) throw new Error("missing remote");
        return remote;
      }
      throw new Error("unexpected git call");
    };

    const repos = await discoverLocalGithubRepos({
      cwd: root,
      env: { SLEEK_REPO_ROOTS: root } as NodeJS.ProcessEnv,
      git,
    });

    expect(repos).toEqual([
      { path: alpha, owner: "acme", repo: "alpha", url: "https://github.com/acme/alpha" },
      { path: beta, owner: "acme", repo: "beta", url: "https://github.com/acme/beta" },
    ]);
  });

  it("uses SLEEK_REPO_ROOTS when configured", async () => {
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    const roots = await defaultRepoSearchRoots(
      root,
      { SLEEK_REPO_ROOTS: `${a}:${b}` } as NodeJS.ProcessEnv,
      async () => {
        throw new Error("git should not be called");
      },
    );
    expect(roots).toEqual([a, b]);
  });

  it("formats picker and non-tty output", () => {
    const repos = [
      { path: "/repos/a", owner: "acme", repo: "a", url: "https://github.com/acme/a" },
    ];
    expect(reposToPickerItems(repos)).toEqual([
      { value: "/repos/a", label: "acme/a", hint: "/repos/a" },
    ]);
    expect(formatRepoList(repos)).toContain("acme/a");
    expect(formatRepoList(repos)).toContain("/repos/a");
    expect(cloneRepoPickerItem(root)).toMatchObject({
      label: "Clone another repo...",
      hint: `into ${root}`,
    });
  });

  it("accepts worktree-style .git files as repo candidates", async () => {
    const repo = join(root, "worktree");
    mkdirSync(repo);
    writeFileSync(join(repo, ".git"), "gitdir: /tmp/gitdir");
    const git: GitRunner = async () => "git@github.com:acme/worktree.git\n";

    const repos = await discoverLocalGithubRepos({
      cwd: root,
      env: { SLEEK_REPO_ROOTS: root } as NodeJS.ProcessEnv,
      git,
    });

    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ path: repo, owner: "acme", repo: "worktree" });
  });

  it("parses github clone targets from shorthand, https, and ssh inputs", () => {
    expect(parseGithubCloneTarget("acme/rocket")).toEqual({
      owner: "acme",
      repo: "rocket",
      url: "https://github.com/acme/rocket",
      cloneUrl: "https://github.com/acme/rocket",
    });
    expect(parseGithubCloneTarget("https://github.com/acme/rocket.git")).toEqual({
      owner: "acme",
      repo: "rocket",
      url: "https://github.com/acme/rocket",
      cloneUrl: "https://github.com/acme/rocket.git",
    });
    expect(parseGithubCloneTarget("git@github.com:acme/rocket.git")).toEqual({
      owner: "acme",
      repo: "rocket",
      url: "https://github.com/acme/rocket",
      cloneUrl: "git@github.com:acme/rocket.git",
    });
    expect(parseGithubCloneTarget("https://example.com/acme/rocket.git")).toBe(null);
  });

  it("clones a GitHub repo into the first configured repo root", async () => {
    const cloneRoot = join(root, "repos");
    const calls: { args: string[]; cwd: string }[] = [];
    const git: GitRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      return "";
    };

    const repo = await cloneGithubRepo({
      cwd: root,
      input: "acme/rocket",
      env: { SLEEK_REPO_ROOTS: cloneRoot } as NodeJS.ProcessEnv,
      git,
    });

    expect(repo).toEqual({
      path: join(cloneRoot, "rocket"),
      owner: "acme",
      repo: "rocket",
      url: "https://github.com/acme/rocket",
    });
    expect(calls).toEqual([
      {
        args: ["clone", "https://github.com/acme/rocket", join(cloneRoot, "rocket")],
        cwd: cloneRoot,
      },
    ]);
  });

  it("rejects clone targets when the destination already exists", async () => {
    const cloneRoot = join(root, "repos");
    mkdirSync(join(cloneRoot, "rocket"), { recursive: true });

    await expect(
      cloneGithubRepo({
        cwd: root,
        input: "acme/rocket",
        env: { SLEEK_REPO_ROOTS: cloneRoot } as NodeJS.ProcessEnv,
        git: async () => "",
      }),
    ).rejects.toThrow(/Destination already exists/);
  });
});
