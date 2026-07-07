import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

import type { ChangeSet, PrMeta } from "../domain/scaffold.ts";
import { collapseNoise } from "./noise.ts";

/**
 * M1 Ingest — produce a {@link ChangeSet} from a GitHub PR using the `gh` CLI.
 *
 * See docs/PLAN.md §3 step 1 and §5 M1. This is the entry into the data flow:
 * `GitHub PR ─▶ Ingest ─▶ ChangeSet (diff + metadata + head SHA)`.
 *
 * Nothing here touches the network directly: every `gh` call goes through an
 * injectable {@link GhRunner}, so the JSON/diff → ChangeSet mapping is unit-testable
 * with fixtures and no network/auth.
 */

/**
 * Runs `gh` with the given args in the given working directory and resolves with
 * its stdout. The one seam between this module and the outside world.
 *
 * `input`, when given, is piped to `gh`'s stdin — used by callers that pass a
 * JSON payload via `gh api … --input -` (Wave 4A review export). The parameter
 * is optional so every existing two-argument runner (fakes, the caching
 * wrapper) remains a valid GhRunner.
 */
export type GhRunner = (
  args: string[],
  cwd: string,
  input?: string,
) => Promise<string>;

/** Runs `git` with the given args in the given working directory and resolves with stdout. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

/** Distinct error kinds so callers (and the UI) can react without string-matching. */
export type IngestErrorKind =
  | "gh-not-installed"
  | "gh-not-authenticated"
  | "repo-not-found"
  | "pr-not-found"
  | "gh-failed"
  | "bad-output";

/** A typed failure from ingest. `kind` classifies it; `cause` keeps the original error. */
export class IngestError extends Error {
  readonly kind: IngestErrorKind;
  override readonly cause?: unknown;

  constructor(kind: IngestErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "IngestError";
    this.kind = kind;
    this.cause = cause;
  }
}

/**
 * Conservative allowlist for ref names / SHAs that came out of `gh` JSON before
 * they are handed to `git` as arguments. execFile never invokes a shell, so the
 * only injection surface left is git's own option parsing — hence the leading-dash
 * rejection on top of the character allowlist.
 */
const SAFE_GIT_REF = /^[A-Za-z0-9._/-]+$/;

/** @throws {IngestError} kind `bad-output` when `ref` is not a safe git argument. */
function assertSafeGitRef(ref: string, label: string): void {
  if (!SAFE_GIT_REF.test(ref) || ref.startsWith("-")) {
    throw new IngestError(
      "bad-output",
      `unsafe git ref for ${label}: ${JSON.stringify(ref)}`,
    );
  }
}

/** The subset of `gh pr view --json ...` output this module relies on. */
interface GhPrView {
  number: number;
  title: string;
  body: string;
  baseRefName: string;
  baseRefOid: string;
  headRefOid: string;
  files: Array<{ path: string }>;
}

const PR_VIEW_JSON_FIELDS = "number,title,body,baseRefName,baseRefOid,headRefOid,files";
const GH_BINARY_CANDIDATES = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"];

export interface ResolveGhBinaryOptions {
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
}

/** Resolve the GitHub CLI even when GUI-launched shells have a thin PATH. */
export function resolveGhBinary(options: ResolveGhBinaryOptions = {}): string {
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const configured = env.SLEEK_GH_BIN ?? env.GH_BIN;
  if (configured) return configured;

  for (const candidate of GH_BINARY_CANDIDATES) {
    if (fileExists(candidate)) return candidate;
  }
  return "gh";
}

/**
 * Default {@link GhRunner}: shells out to the real `gh` binary via
 * `node:child_process`. No shell is spawned (execFile), so args are passed
 * verbatim and are not subject to shell interpolation.
 */
/**
 * Default {@link GitRunner}: shells out to `git` via `node:child_process`.
 * No shell is spawned (execFile), so args are passed verbatim.
 */
export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || String(error)}`));
        return;
      }
      resolve(stdout);
    });
  });

export const defaultGhRunner: GhRunner = (args, cwd, input) =>
  new Promise<string>((resolve, reject) => {
    if (!existsSync(cwd)) {
      reject(
        new IngestError(
          "repo-not-found",
          `Repository path does not exist: ${cwd}`,
        ),
      );
      return;
    }

    const child = execFile(
      resolveGhBinary(),
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(classifyGhError(error, stderr, args));
          return;
        }
        resolve(stdout);
      },
    );

    // Pipe the payload to gh's stdin (`--input -`); errors on a closed pipe are
    // surfaced through execFile's callback, so EPIPE here is safe to swallow.
    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });

/** Node's exec error carries an ENOENT `code` when the binary is missing. */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** Map a raw `gh` failure onto a typed {@link IngestError}. */
function classifyGhError(
  error: unknown,
  stderr: string,
  args: string[],
): IngestError {
  if (isEnoent(error)) {
    return new IngestError(
      "gh-not-installed",
      "The `gh` CLI was not found on PATH or in common Homebrew locations. " +
        "Install GitHub CLI: https://cli.github.com, or set SLEEK_GH_BIN=/path/to/gh.",
      error,
    );
  }

  const text = stderr.toLowerCase();
  if (
    text.includes("not logged in") ||
    text.includes("authentication") ||
    text.includes("gh auth login")
  ) {
    return new IngestError(
      "gh-not-authenticated",
      "`gh` is not authenticated. Run `gh auth login`.",
      error,
    );
  }
  if (
    text.includes("no pull requests found") ||
    text.includes("could not resolve to a pullrequest") ||
    text.includes("not found")
  ) {
    return new IngestError(
      "pr-not-found",
      `No pull request found for \`gh ${args.join(" ")}\`.`,
      error,
    );
  }

  return new IngestError(
    "gh-failed",
    `\`gh ${args.join(" ")}\` failed: ${stderr.trim() || String(error)}`,
    error,
  );
}

/** Parse and shape-check `gh pr view` JSON, throwing a typed error on malformed output. */
function parsePrView(raw: string): GhPrView {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (cause) {
    throw new IngestError(
      "bad-output",
      "Could not parse `gh pr view` JSON output.",
      cause,
    );
  }

  const view = data as Partial<GhPrView>;
  if (
    typeof view.number !== "number" ||
    typeof view.title !== "string" ||
    typeof view.body !== "string" ||
    typeof view.baseRefOid !== "string" ||
    typeof view.headRefOid !== "string" ||
    !Array.isArray(view.files)
  ) {
    throw new IngestError(
      "bad-output",
      "`gh pr view` JSON is missing expected fields (number, title, body, baseRefOid, headRefOid, files).",
    );
  }

  return view as GhPrView;
}

/** The subset of `gh repo view --json defaultBranchRef` output this module relies on. */
interface GhRepoView {
  defaultBranchRef: { name: string };
}

/** Parse and shape-check `gh repo view` JSON, returning null on malformed output. */
function parseRepoView(raw: string): GhRepoView | null {
  try {
    const data = JSON.parse(raw) as Partial<GhRepoView>;
    if (typeof data.defaultBranchRef?.name === "string") {
      return data as GhRepoView;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch a GitHub PR and map it to a {@link ChangeSet}.
 *
 * Runs `gh pr view <n> --json number,title,body,baseRefOid,headRefOid,files` for
 * metadata + changed files, and `gh pr diff <n>` for the unified diff, both in
 * `opts.cwd` (defaults to the current process cwd — the Reviewer's repo clone).
 *
 * @throws {IngestError} with a classified `kind` when `gh` is missing, not
 * authenticated, the PR is not found, or the output is malformed.
 */
export async function ingestPr(
  prNumber: number,
  opts: { cwd?: string; gh?: GhRunner; git?: GitRunner } = {},
): Promise<ChangeSet> {
  const cwd = opts.cwd ?? process.cwd();
  const gh = opts.gh ?? defaultGhRunner;
  const git = opts.git;
  const n = String(prNumber);

  // Metadata + changed files. Sequential so a missing-PR / auth error surfaces once.
  const viewRaw = await gh(
    ["pr", "view", n, "--json", PR_VIEW_JSON_FIELDS],
    cwd,
  );
  const view = parsePrView(viewRaw);
  assertSafeGitRef(view.headRefOid, "headRefOid");
  assertSafeGitRef(view.baseRefOid, "baseRefOid");

  // B6: attempt merge-base diff; fall back to gh pr diff on any git failure.
  let unifiedDiff: string;
  try {
    if (!git) throw new Error("no git runner");
    const mergeBase = (
      await git(["merge-base", view.headRefOid, view.baseRefOid], cwd)
    ).trim();
    assertSafeGitRef(mergeBase, "merge-base output");
    // `--` terminates revision args so neither ref can be misread as a pathspec.
    unifiedDiff = await git(["diff", mergeBase, view.headRefOid, "--"], cwd);
  } catch {
    unifiedDiff = await gh(["pr", "diff", n], cwd);
  }

  // B6: determine stackedOnto from default branch.
  let stackedOnto: string | null | undefined;
  try {
    const repoRaw = await gh(["repo", "view", "--json", "defaultBranchRef"], cwd);
    const repoView = parseRepoView(repoRaw);
    if (repoView) {
      stackedOnto =
        view.baseRefName !== repoView.defaultBranchRef.name
          ? view.baseRefName
          : null;
    }
  } catch {
    // leave stackedOnto undefined
  }

  const pr: PrMeta = {
    number: view.number,
    title: view.title,
    description: view.body,
    baseSha: view.baseRefOid,
    headSha: view.headRefOid,
    ...(stackedOnto !== undefined ? { stackedOnto } : {}),
  };

  // B1: collapse noise files.
  const { diff: collapsedDiff, noiseFiles } = await collapseNoise(unifiedDiff, { git, cwd });

  return {
    pr,
    unifiedDiff: collapsedDiff,
    files: view.files.map((f) => f.path),
    noiseFiles,
  };
}
