/**
 * Wave-6 `sleek review` (no-arg) — interactive PR picker.
 *
 * TTY path: stdin raw mode, hide cursor, rerender in-place.
 * Non-TTY path: print numbered list, exit 1.
 */

import { createInterface } from "node:readline/promises";

import { defaultGhRunner } from "../../ingest/ingest.ts";
import { parseGhPrList, prListToPickerItems, formatPrList } from "../prItems.ts";
import { pickerInit, pickerKey, pickerRender, decodeKey } from "../picker.ts";
import type { PickerItem, PickerState } from "../picker.ts";
import {
  CLONE_REPO_PICKER_VALUE,
  cloneGithubRepo,
  cloneRepoPickerItem,
  defaultRepoSearchRoots,
  discoverLocalGithubRepos,
  formatRepoList,
  reposToPickerItems,
} from "../repoDiscovery.ts";
import { runReview } from "./review.ts";

export interface PickOptions {
  repo: string;
  repoExplicit?: boolean;
  /** For injection in tests (overrides the real gh runner). */
  ghOverride?: (args: string[], cwd: string) => Promise<string>;
}

export async function runPick(opts: PickOptions): Promise<void> {
  let { repo } = opts;
  const gh = opts.ghOverride ?? defaultGhRunner;

  if (opts.repoExplicit !== true) {
    const [cloneRoot] = await defaultRepoSearchRoots(repo);
    const repos = await discoverLocalGithubRepos({ cwd: repo });

    if (!process.stdin.isTTY) {
      process.stdout.write(formatRepoList(repos) + "\n");
      process.stdout.write(
        "\nrun: git clone https://github.com/<owner>/<repo> " +
          `${cloneRoot ?? "<path>"} && sleek review --repo <path>\n`,
      );
      process.exit(1);
      return;
    }

    const selectedRepo = await selectInteractive(
      [
        ...reposToPickerItems(repos),
        cloneRepoPickerItem(cloneRoot ?? process.cwd()),
      ],
      "Select GitHub repo",
    );
    if (selectedRepo === null) {
      process.stderr.write("\nCancelled.\n");
      process.exit(0);
      return;
    }
    if (selectedRepo === CLONE_REPO_PICKER_VALUE) {
      const cloned = await promptAndCloneRepo(repo);
      if (cloned === null) {
        process.stderr.write("\nCancelled.\n");
        process.exit(0);
        return;
      }
      repo = cloned;
    } else {
      repo = selectedRepo;
    }
    process.stderr.write(`\nSelected repo ${repo}\n`);
  }

  // Fetch PR list
  let raw: string;
  try {
    raw = await gh(
      ["pr", "list", "--json", "number,title,headRefName,author,updatedAt"],
      repo,
    );
  } catch (err) {
    process.stderr.write(`Failed to list PRs: ${String(err)}\n`);
    process.exit(1);
  }

  const entries = parseGhPrList(raw);

  if (entries.length === 0) {
    process.stderr.write("No open PRs found.\n");
    process.exit(0);
    return;
  }

  // Non-TTY path: print numbered list and exit 1
  if (!process.stdin.isTTY) {
    process.stdout.write(formatPrList(entries) + "\n");
    process.stdout.write(`\nrun: sleek review <pr> --repo ${repo}\n`);
    process.exit(1);
    return;
  }

  // TTY path: interactive picker
  const selectedPr = await selectInteractive(
    prListToPickerItems(entries),
    "Select pull request",
  );
  if (selectedPr === null) {
    process.stderr.write("\nCancelled.\n");
    process.exit(0);
    return;
  }

  const pr = Number(selectedPr);
  process.stderr.write(`\nSelected PR #${pr}\n`);
  await runReview({ pr, repo, open: false, json: false, refresh: false, process: false });
}

async function promptAndCloneRepo(cwd: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("GitHub repo to clone (owner/repo or URL): ");
    if (answer.trim() === "") return null;
    process.stderr.write("Cloning repo...\n");
    const repo = await cloneGithubRepo({ cwd, input: answer });
    return repo.path;
  } catch (err) {
    process.stderr.write(`Failed to clone repo: ${String(err)}\n`);
    process.exit(1);
    return null;
  } finally {
    rl.close();
  }
}

async function selectInteractive(
  items: PickerItem[],
  title: string,
): Promise<string | null> {
  const height = Math.min(items.length, 12);
  let state: PickerState = pickerInit(items, height);

  const width = process.stdout.columns ?? 80;
  process.stdout.write(`${title}\n`);

  // Hide cursor, enter raw mode
  process.stdout.write("\x1b[?25l");
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let rendered: string[] = [];

  function render(): void {
    const lines = pickerRender(state, width);
    // Move up to overwrite previous render
    if (rendered.length > 0) {
      process.stdout.write(`\x1b[${rendered.length}A`);
    }
    const rows = Math.max(rendered.length, lines.length);
    for (let i = 0; i < rows; i++) {
      process.stdout.write((lines[i] ?? "") + "\x1b[K\n");
    }
    rendered = lines;
  }

  function restore(): void {
    // Move below rendered lines, show cursor
    process.stdout.write("\x1b[?25h");
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  return new Promise((resolve) => {
    function finish(value: string | null): void {
      process.stdin.off("data", onData);
      process.off("SIGINT", onSigint);
      restore();
      resolve(value);
    }

    function onSigint(): void {
      finish(null);
    }

    function onData(chunk: Buffer): void {
      const key = decodeKey(chunk.toString());
      if (!key) return;

      state = pickerKey(state, key);
      render();

      if (!state.done) return;
      finish(state.done.kind === "selected" ? state.done.value : null);
    }

    process.stdin.on("data", onData);
    process.once("SIGINT", onSigint);
    render();
  });
}
