import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ServerRegistryEntry {
  url: string;
  repo: string;
  pr: number;
  headSha: string;
  startedAt: string;
}

export interface ServerRegistry {
  entries: ServerRegistryEntry[];
}

export interface RegistryPaths {
  registryPath?: string;
}

export function defaultRegistryPath(): string {
  const xdg = process.env.XDG_STATE_HOME;
  return join(xdg && xdg.trim() ? xdg : join(homedir(), ".local", "state"), "sleek", "servers.json");
}

export function normalizeRepoPath(repo: string): string {
  const abs = resolve(repo);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function pathOf(paths: RegistryPaths = {}): string {
  return paths.registryPath ?? defaultRegistryPath();
}

export function readRegistry(paths: RegistryPaths = {}): ServerRegistry {
  try {
    const parsed = JSON.parse(readFileSync(pathOf(paths), "utf8")) as Partial<ServerRegistry>;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries as ServerRegistryEntry[] : [] };
  } catch {
    return { entries: [] };
  }
}

function writeRegistry(registry: ServerRegistry, paths: RegistryPaths = {}): void {
  const file = pathOf(paths);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(registry, null, 2) + "\n");
}

function sameScope(a: ServerRegistryEntry, b: Pick<ServerRegistryEntry, "repo" | "pr" | "headSha">): boolean {
  return a.repo === b.repo && a.pr === b.pr && a.headSha === b.headSha;
}

export function registerServer(entry: ServerRegistryEntry, paths: RegistryPaths = {}): void {
  const repo = normalizeRepoPath(entry.repo);
  const registry = readRegistry(paths);
  const next = registry.entries.filter((e) => !sameScope(e, { ...entry, repo }));
  next.push({ ...entry, repo });
  writeRegistry({ entries: next }, paths);
}

export function unregisterServer(
  scope: Pick<ServerRegistryEntry, "repo" | "pr" | "headSha">,
  paths: RegistryPaths = {},
): void {
  const repo = normalizeRepoPath(scope.repo);
  const registry = readRegistry(paths);
  const next = registry.entries.filter((e) => !sameScope(e, { ...scope, repo }));
  if (next.length === 0) {
    rmSync(pathOf(paths), { force: true });
    return;
  }
  writeRegistry({ entries: next }, paths);
}

export interface FindActiveServerOptions extends RegistryPaths {
  repo: string;
  pr: number;
  headSha?: string;
  probe?: (url: string) => Promise<boolean>;
}

export async function findActiveServer(
  opts: FindActiveServerOptions,
): Promise<ServerRegistryEntry | null> {
  const repo = normalizeRepoPath(opts.repo);
  const probe = opts.probe ?? defaultProbe;
  const registry = readRegistry(opts);
  const candidates = registry.entries
    .filter((e) => e.repo === repo && e.pr === opts.pr && (opts.headSha === undefined || e.headSha === opts.headSha))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const liveEntries: ServerRegistryEntry[] = [];
  const liveUrls = new Set<string>();
  for (const entry of registry.entries) {
    if (await probe(entry.url)) {
      liveEntries.push(entry);
      liveUrls.add(entry.url);
    }
  }

  if (liveEntries.length !== registry.entries.length) {
    writeRegistry({ entries: liveEntries }, opts);
  }
  return candidates.find((entry) => liveUrls.has(entry.url)) ?? null;
}

async function defaultProbe(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 600);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/health`, { signal: ctrl.signal });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
