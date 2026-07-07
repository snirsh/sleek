/**
 * B3 — Graph-aware grouping via nx / turbo dependency graph.
 *
 * Detects monorepo tooling in the target worktree, runs the graph command with a
 * 5-second timeout, parses the output into file->project + project dep edges, then
 * computes per-file centrality and builds project clusters.
 *
 * FAIL SOFT: any error (no tool, command failure, timeout, parse error) returns null.
 * Callers MUST fall back to current behavior when null is returned.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Injectable command runner. Signature: run a shell command in a cwd, return stdout. */
export type GraphRunner = (cmd: string, cwd: string) => Promise<string>;

export interface GraphResult {
  /** changedFile -> projectName */
  fileProject: Record<string, string>;
  /** project-level dep edges */
  edges: Array<{ from: string; to: string }>;
  /** changedFile -> [0,1] centrality (in-degree + out-degree, normalized) */
  centralityByFile: Record<string, number>;
  /** project clusters: each project that has changed files, with their region indexes */
  clusters: Array<{ project: string; regionIndexes: number[] }>;
}

/** Default runner: spawns the command via child_process with a 5s timeout. */
async function defaultRunner(cmd: string, cwd: string): Promise<string> {
  const parts = cmd.split(" ");
  const bin = parts[0]!;
  const args = parts.slice(1);
  const result = await execFileAsync(bin, args, { cwd, timeout: 5000, encoding: "utf8" });
  return result.stdout;
}

/** Check if a file exists (fail-soft). */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute (in-degree + out-degree) for each project in the edge list,
 * normalized to [0,1] across all projects that appear in `projects`.
 */
function computeCentrality(
  projects: string[],
  edges: Array<{ from: string; to: string }>,
): Record<string, number> {
  const degree: Record<string, number> = {};
  for (const p of projects) degree[p] = 0;
  for (const { from, to } of edges) {
    if (from in degree) degree[from]++;
    if (to in degree) degree[to]++;
  }
  const max = Math.max(1, ...Object.values(degree));
  const normalized: Record<string, number> = {};
  for (const [p, d] of Object.entries(degree)) {
    normalized[p] = d / max;
  }
  return normalized;
}

/**
 * Map each changed file to its project and build clusters keyed by project.
 */
function buildClusters(
  fileProject: Record<string, string>,
  regionFileMap: Array<{ file: string; regionIndex: number }>,
): Array<{ project: string; regionIndexes: number[] }> {
  const projectRegions: Record<string, number[]> = {};
  for (const { file, regionIndex } of regionFileMap) {
    const project = fileProject[file];
    if (!project) continue;
    if (!projectRegions[project]) projectRegions[project] = [];
    projectRegions[project].push(regionIndex);
  }
  return Object.entries(projectRegions).map(([project, regionIndexes]) => ({
    project,
    regionIndexes,
  }));
}

/** Parse nx graph JSON (from `nx graph --file=<path>`) */
function parseNxGraph(
  json: unknown,
  changedFiles: string[],
  worktreePath: string,
): { fileProject: Record<string, string>; edges: Array<{ from: string; to: string }> } | null {
  if (
    typeof json !== "object" ||
    json === null ||
    !("graph" in json)
  ) return null;

  const graph = (json as { graph: unknown }).graph;
  if (typeof graph !== "object" || graph === null) return null;
  const { nodes, dependencies } = graph as { nodes?: unknown; dependencies?: unknown };

  if (typeof nodes !== "object" || nodes === null) return null;

  // Build file -> project map using each project's `data.root`
  const fileProject: Record<string, string> = {};
  const projectRoots: Array<{ project: string; root: string }> = [];

  for (const [projectName, nodeData] of Object.entries(nodes as Record<string, unknown>)) {
    const data = (nodeData as { data?: { root?: string } })?.data;
    if (!data?.root) continue;
    projectRoots.push({ project: projectName, root: data.root });
  }

  for (const file of changedFiles) {
    const rel = relative(worktreePath, file.startsWith("/") ? file : join(worktreePath, file));
    // Find the most-specific project root that this file is under
    let bestMatch: { project: string; root: string } | undefined;
    for (const { project, root } of projectRoots) {
      if (rel.startsWith(root + "/") || rel === root) {
        if (!bestMatch || root.length > bestMatch.root.length) {
          bestMatch = { project, root };
        }
      }
    }
    if (bestMatch) {
      fileProject[file] = bestMatch.project;
    }
  }

  // Build edges from dependencies
  const edges: Array<{ from: string; to: string }> = [];
  if (typeof dependencies === "object" && dependencies !== null) {
    for (const [project, deps] of Object.entries(dependencies as Record<string, unknown>)) {
      if (!Array.isArray(deps)) continue;
      for (const dep of deps) {
        if (typeof dep === "object" && dep !== null && "target" in dep) {
          edges.push({ from: project, to: (dep as { target: string }).target });
        }
      }
    }
  }

  return { fileProject, edges };
}

/** Parse turbo dry-run JSON (from `turbo run build --dry=json`) */
function parseTurboGraph(
  json: unknown,
  changedFiles: string[],
  worktreePath: string,
): { fileProject: Record<string, string>; edges: Array<{ from: string; to: string }> } | null {
  if (
    typeof json !== "object" ||
    json === null ||
    !("tasks" in json)
  ) return null;

  const tasks = (json as { tasks: unknown }).tasks;
  if (!Array.isArray(tasks)) return null;

  // Build package -> root path (turbo tasks have `package` and `directory` fields)
  const packageRoots: Array<{ pkg: string; dir: string }> = [];
  for (const task of tasks) {
    if (typeof task !== "object" || task === null) continue;
    const { package: pkg, directory } = task as { package?: string; directory?: string };
    if (!pkg || !directory) continue;
    if (!packageRoots.some((p) => p.pkg === pkg)) {
      packageRoots.push({ pkg, dir: directory });
    }
  }

  const fileProject: Record<string, string> = {};
  for (const file of changedFiles) {
    const rel = relative(worktreePath, file.startsWith("/") ? file : join(worktreePath, file));
    let bestMatch: { pkg: string; dir: string } | undefined;
    for (const { pkg, dir } of packageRoots) {
      if (rel.startsWith(dir + "/") || rel === dir) {
        if (!bestMatch || dir.length > bestMatch.dir.length) {
          bestMatch = { pkg, dir };
        }
      }
    }
    if (bestMatch) {
      fileProject[file] = bestMatch.pkg;
    }
  }

  // Build edges from task dependencies
  const edges: Array<{ from: string; to: string }> = [];
  for (const task of tasks) {
    if (typeof task !== "object" || task === null) continue;
    const { package: pkg, dependencies } = task as { package?: string; dependencies?: string[] };
    if (!pkg || !Array.isArray(dependencies)) continue;
    for (const dep of dependencies) {
      // dep may be "pkg#task" format
      const depPkg = dep.includes("#") ? dep.split("#")[0]! : dep;
      if (depPkg !== pkg) {
        edges.push({ from: pkg, to: depPkg });
      }
    }
  }

  return { fileProject, edges };
}

/**
 * Build the dependency graph for a worktree.
 *
 * Returns null (fail-soft) when:
 *  - no nx.json or turbo.json is found in the worktree root
 *  - the graph command fails or times out (5s)
 *  - the output cannot be parsed
 *
 * When non-null, `regionFileMap` maps each changed file (by index in changedFiles) to
 * its region index list so clusters can be built.
 */
export async function buildGraph(
  worktreePath: string,
  changedFiles: string[],
  regionFileMap?: Array<{ file: string; regionIndex: number }>,
  runner?: GraphRunner,
): Promise<GraphResult | null> {
  const run = runner ?? defaultRunner;

  try {
    const hasNx = await fileExists(join(worktreePath, "nx.json"));
    const hasTurbo = await fileExists(join(worktreePath, "turbo.json"));

    if (!hasNx && !hasTurbo) return null;

    let parsed: { fileProject: Record<string, string>; edges: Array<{ from: string; to: string }> } | null = null;

    if (hasNx) {
      // Write output to a temp file so nx graph can use --file=
      const tmpDir = await mkdtemp(join(tmpdir(), "sleek-nx-"));
      const outFile = join(tmpDir, "graph.json");
      try {
        await run("npx nx graph --file=" + outFile, worktreePath);
        const raw = await readFile(outFile, "utf8");
        const json = JSON.parse(raw) as unknown;
        parsed = parseNxGraph(json, changedFiles, worktreePath);
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } else if (hasTurbo) {
      const stdout = await run("npx turbo run build --dry=json", worktreePath);
      const json = JSON.parse(stdout) as unknown;
      parsed = parseTurboGraph(json, changedFiles, worktreePath);
    }

    if (!parsed) return null;

    const { fileProject, edges } = parsed;

    // Compute centrality for all projects that appear as fileProject values
    const allProjects = Array.from(new Set(Object.values(fileProject)));
    const projectCentrality = computeCentrality(allProjects, edges);

    // Map file -> centrality via its project
    const centralityByFile: Record<string, number> = {};
    for (const file of changedFiles) {
      const project = fileProject[file];
      if (project !== undefined) {
        centralityByFile[file] = projectCentrality[project] ?? 0;
      }
    }

    const clusters = buildClusters(
      fileProject,
      regionFileMap ?? changedFiles.map((file, i) => ({ file, regionIndex: i })),
    );

    return { fileProject, edges, centralityByFile, clusters };
  } catch {
    return null;
  }
}
