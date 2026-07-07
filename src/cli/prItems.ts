/**
 * Wave-6 PR picker items: maps `gh pr list` JSON output to PickerItems
 * and formats relative ages. Pure — fully testable.
 */

import type { PickerItem } from "./picker.ts";

/** Shape of one entry from `gh pr list --json number,title,headRefName,author,updatedAt`. */
export interface GhPrListEntry {
  number: number;
  title: string;
  headRefName: string;
  author: { login: string };
  updatedAt: string; // ISO-8601
}

/**
 * Format a relative age string from an ISO-8601 timestamp and a reference "now".
 * Returns e.g. "2d ago", "3h ago", "5m ago", "just now".
 */
export function relativeAge(isoTimestamp: string, now = new Date()): string {
  const then = new Date(isoTimestamp);
  const diffMs = now.getTime() - then.getTime();
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

  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

/**
 * Map a list of `gh pr list` entries to PickerItems.
 * label: "#123 Fix hydration mismatch"
 * hint: "user:branch · 2d ago"
 */
export function prListToPickerItems(
  entries: GhPrListEntry[],
  now = new Date(),
): PickerItem[] {
  return entries.map((entry) => ({
    value: String(entry.number),
    label: `#${entry.number} ${entry.title}`,
    hint: `${entry.author.login}:${entry.headRefName} · ${relativeAge(entry.updatedAt, now)}`,
  }));
}

/** Parse the raw JSON string from `gh pr list --json ...`. Throws on bad input. */
export function parseGhPrList(raw: string): GhPrListEntry[] {
  const data = JSON.parse(raw) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("Expected a JSON array from `gh pr list`");
  }
  return data as GhPrListEntry[];
}

/** Format a numbered plain list of PRs for non-TTY fallback (exits 1). */
export function formatPrList(entries: GhPrListEntry[], now = new Date()): string {
  if (entries.length === 0) return "No open PRs found.";
  return entries
    .map(
      (e, i) =>
        `  ${String(i + 1).padStart(3)}.  #${e.number}  ${e.title}  (${relativeAge(e.updatedAt, now)})`,
    )
    .join("\n");
}
