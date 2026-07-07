/**
 * Wave-6 `sleek list` — list scaffolds in the store.
 */

import { mkdirSync } from "node:fs";

import { openStore } from "../../store/index.ts";
import type { PrSummary } from "../../store/index.ts";

export interface ListOptions {
  repo: string;
  json: boolean;
}

export async function runList(opts: ListOptions): Promise<void> {
  const { repo, json: jsonMode } = opts;

  mkdirSync(`${repo}/.sleek`, { recursive: true });
  const store = openStore(`${repo}/.sleek/demo.db`);

  try {
    const prs = store.listAllPrs();

    if (jsonMode) {
      process.stdout.write(JSON.stringify(prs) + "\n");
      return;
    }

    if (prs.length === 0) {
      process.stdout.write("No scaffolds stored. Run:  sleek review <pr>\n");
      return;
    }

    const lines = prs.map((p: PrSummary) => {
      const age = relativeAge(p.latestCreatedAt);
      const sha = p.latestHeadSha.slice(0, 12);
      const v = p.versions === 1 ? "1 version" : `${p.versions} versions`;
      return `  PR #${p.prNumber}  ${sha}  ${v}  (${age})`;
    });
    process.stdout.write(lines.join("\n") + "\n");
  } finally {
    store.close();
  }
}

function relativeAge(isoTimestamp: string): string {
  const then = new Date(isoTimestamp);
  const diffMs = Date.now() - then.getTime();
  if (diffMs < 0) return "just now";
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
