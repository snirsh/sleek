import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, delimiter, join, resolve } from "node:path";

import { parseRepoIdentity } from "../export/github.ts";
import type { GitRunner } from "../ingest/ingest.ts";
import { defaultGitRunner } from "../ingest/ingest.ts";
import type { PickerItem } from "./picker.ts";

export interface LocalGithubRepo {
  path: string;
  owner: string;
  repo: string;
  url: string;
}

export interface DiscoverReposOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  git?: GitRunner;
}

export interface GithubCloneTarget {
  owner: string;
  repo: string;
  url: string;
  cloneUrl: string;
}

export const CLONE_REPO_PICKER_VALUE = "__sleek_clone_repo__";

export function normalizeGithubRemote(remote: string): string | null {
  const normalized = remote
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  return normalized.includes("github.com") ? normalized : null;
}

async function currentGitRoot(cwd: string, git: GitRunner): Promise<string | null> {
  try {
    return (await git(["rev-parse", "--show-toplevel"], cwd)).trim() || null;
  } catch {
    return null;
  }
}

export async function defaultRepoSearchRoots(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  git: GitRunner = defaultGitRunner,
): Promise<string[]> {
  const configured = env.SLEEK_REPO_ROOTS;
  if (configured && configured.trim() !== "") {
    return configured
      .split(delimiter)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => resolve(p));
  }

  const gitRoot = await currentGitRoot(cwd, git);
  const base = gitRoot ?? cwd;
  return [dirname(resolve(base))];
}

function hasGitDir(path: string): boolean {
  return existsSync(`${path}/.git`);
}

function candidatePaths(root: string): string[] {
  const out: string[] = [];
  if (hasGitDir(root)) out.push(root);

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = resolve(root, entry.name);
      if (hasGitDir(full)) out.push(full);
    }
  } catch {
    // Unreadable roots are ignored; another configured root may still work.
  }

  return out;
}

export async function discoverLocalGithubRepos(
  opts: DiscoverReposOptions,
): Promise<LocalGithubRepo[]> {
  const git = opts.git ?? defaultGitRunner;
  const roots = await defaultRepoSearchRoots(opts.cwd, opts.env, git);
  const seen = new Set<string>();
  const repos: LocalGithubRepo[] = [];

  for (const root of roots) {
    for (const candidate of candidatePaths(root)) {
      const path = resolve(candidate);
      if (seen.has(path)) continue;
      seen.add(path);

      let remote: string;
      try {
        remote = await git(["remote", "get-url", "origin"], path);
      } catch {
        continue;
      }
      const url = normalizeGithubRemote(remote);
      if (!url) continue;
      const identity = parseRepoIdentity(url);
      if (!identity) continue;
      repos.push({ path, owner: identity.owner, repo: identity.repo, url });
    }
  }

  return repos.sort(
    (a, b) =>
      `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`) ||
      a.path.localeCompare(b.path),
  );
}

export function reposToPickerItems(repos: readonly LocalGithubRepo[]): PickerItem[] {
  return repos.map((repo) => ({
    value: repo.path,
    label: `${repo.owner}/${repo.repo}`,
    hint: repo.path,
  }));
}

export function cloneRepoPickerItem(root: string): PickerItem {
  return {
    value: CLONE_REPO_PICKER_VALUE,
    label: "Clone another repo...",
    hint: `into ${root}`,
  };
}

export function parseGithubCloneTarget(input: string): GithubCloneTarget | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  const shorthand = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(trimmed);
  if (shorthand && !trimmed.includes("github.com")) {
    const owner = shorthand[1]!;
    const repo = shorthand[2]!;
    const url = `https://github.com/${owner}/${repo}`;
    return { owner, repo, url, cloneUrl: url };
  }

  const url = normalizeGithubRemote(trimmed);
  if (!url) return null;
  const identity = parseRepoIdentity(url);
  if (!identity) return null;
  return { ...identity, url, cloneUrl: trimmed };
}

export async function cloneGithubRepo(opts: {
  cwd: string;
  input: string;
  env?: NodeJS.ProcessEnv;
  git?: GitRunner;
}): Promise<LocalGithubRepo> {
  const git = opts.git ?? defaultGitRunner;
  const target = parseGithubCloneTarget(opts.input);
  if (!target) {
    throw new Error("Enter a GitHub repo as owner/repo or a github.com URL.");
  }

  const [root] = await defaultRepoSearchRoots(opts.cwd, opts.env, git);
  if (!root) throw new Error("No repo search root is configured.");
  const destination = resolve(join(root, target.repo));
  if (existsSync(destination)) {
    throw new Error(`Destination already exists: ${destination}`);
  }

  mkdirSync(root, { recursive: true });
  await git(["clone", target.cloneUrl, destination], root);
  return {
    path: destination,
    owner: target.owner,
    repo: target.repo,
    url: target.url,
  };
}

export function formatRepoList(repos: readonly LocalGithubRepo[]): string {
  if (repos.length === 0) return "No local GitHub repos found.";
  return repos
    .map(
      (repo, i) =>
        `  ${String(i + 1).padStart(3)}.  ${repo.owner}/${repo.repo}  ${repo.path}`,
    )
    .join("\n");
}
