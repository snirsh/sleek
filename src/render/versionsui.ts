import type {
  ScaffoldDiff,
  ScaffoldDiffCounts,
} from "../domain/scaffolddiff.ts";

/**
 * Pure helpers for the Wave-4B "Changes since last scaffold" UI — the staleness
 * banner under the topbar and the versions panel it opens. The server computes
 * the ScaffoldDiff (src/domain/scaffolddiff.ts, GET /api/versions/diff); these
 * helpers turn it and the /api/versions list into display strings and a flat
 * section/list model the client renders as plain ULs.
 *
 * SHIPPING MODEL (same as threadsui.ts / markdown.ts): these exact functions
 * also run in the browser — client.ts injects each fn.toString() into
 * CLIENT_JS, so every body must stay fully self-contained: no imports, no
 * references to module scope, no TS-only runtime syntax, and NO backticks or
 * ${} (client code is string-concat only). versionsui.test.ts covers the very
 * functions the page runs. (The type-only imports above are erased.)
 */

/** One row of GET /api/versions (client's view). */
export interface VersionEntry {
  headSha: string;
  createdAt: string;
  current: boolean;
}

/** A rendered section of the versions panel: a heading plus plain-text items. */
export interface DiffSection {
  title: string;
  items: string[];
}

/** Display form of a head SHA: the first 12 characters. */
export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/**
 * Human label for a version's createdAt (ISO-8601 UTC from the store):
 * "2026-07-02 14:05 UTC". Kept in UTC by string slicing — deterministic
 * everywhere (no locale/timezone dependence), honest about what it is.
 */
export function versionDateLabel(iso: string): string {
  if (iso.length < 16 || iso.indexOf("T") !== 10) return iso;
  return iso.slice(0, 10) + " " + iso.slice(11, 16) + " UTC";
}

/**
 * Picker label for one stored version: "abc123def456 · 2026-07-02 14:05 UTC".
 * Calls shortSha/versionDateLabel by name — client.ts ships all three sources
 * into the same scope (the paletteMatches→fuzzyScore pattern).
 */
export function versionOptionLabel(v: { headSha: string; createdAt: string }): string {
  return shortSha(v.headSha) + " · " + versionDateLabel(v.createdAt);
}

/**
 * The banner copy: "Scaffold updated · N previous version(s)". The trailing
 * "What changed?" affordance is a separate button, not part of this label.
 */
export function versionsBannerLabel(previousCount: number): string {
  return (
    "Scaffold updated · " +
    previousCount +
    " previous version" +
    (previousCount === 1 ? "" : "s")
  );
}

/**
 * The count summary line at the top of the versions panel, e.g.
 * "2 findings added · 1 finding removed · 1 layer changed". Zero-count parts
 * are omitted; an all-zero diff reads "No structural changes between these
 * scaffold versions."
 */
export function diffCountsLabel(counts: ScaffoldDiffCounts): string {
  const part = (n: number, noun: string, suffix: string): string =>
    n + " " + noun + (n === 1 ? "" : "s") + " " + suffix;
  const parts: string[] = [];
  if (counts.layersAdded) parts.push(part(counts.layersAdded, "layer", "added"));
  if (counts.layersRemoved) parts.push(part(counts.layersRemoved, "layer", "removed"));
  if (counts.layersChanged) parts.push(part(counts.layersChanged, "layer", "changed"));
  if (counts.findingsAdded) parts.push(part(counts.findingsAdded, "finding", "added"));
  if (counts.findingsRemoved) parts.push(part(counts.findingsRemoved, "finding", "removed"));
  if (counts.findingsMoved) parts.push(part(counts.findingsMoved, "finding", "moved"));
  if (counts.filesEntering) parts.push(part(counts.filesEntering, "file", "entering"));
  if (counts.filesLeaving) parts.push(part(counts.filesLeaving, "file", "leaving"));
  if (!parts.length) return "No structural changes between these scaffold versions.";
  return parts.join(" · ");
}

/**
 * Flatten a ScaffoldDiff into ordered panel sections (layers → findings →
 * files), skipping empty ones. Items are plain strings — the client builds
 * text nodes from them, so nothing here needs escaping. Finding text is
 * truncated to its first line, ~80 chars (same posture as firstLineSummary).
 */
export function diffSections(diff: ScaffoldDiff): DiffSection[] {
  const anchorText = (a: { file: string; side: string; startLine: number; endLine: number }): string => {
    const range =
      a.endLine !== a.startLine
        ? a.startLine + "–" + a.endLine
        : String(a.startLine);
    return a.file + ":" + range + (a.side === "RIGHT" ? " (new)" : " (old)");
  };
  const firstLine = (text: string): string => {
    let s = "";
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== "") { s = lines[i].trim(); break; }
    }
    return s.length > 80 ? s.slice(0, 79).trimEnd() + "…" : s;
  };
  const layerItem = (l: { id: string; files: string[]; findingCount: number }): string =>
    l.id +
    " · " +
    l.files.join(", ") +
    " · " +
    l.findingCount +
    " finding" +
    (l.findingCount === 1 ? "" : "s");
  const findingItem = (f: {
    severity: string; concern: string; text: string;
    anchor: { file: string; side: string; startLine: number; endLine: number };
  }): string =>
    "[" + f.severity + "] " + f.concern + " · " + anchorText(f.anchor) + " — " + firstLine(f.text);

  const sections: DiffSection[] = [];
  const add = (title: string, items: string[]): void => {
    if (items.length) sections.push({ title: title + " (" + items.length + ")", items: items });
  };

  add("Layers added", diff.layers.added.map(layerItem));
  add("Layers removed", diff.layers.removed.map(layerItem));
  add(
    "Layers changed",
    diff.layers.changed.map((c) => {
      const what: string[] = [];
      if (c.renamed) what.push("renamed");
      if (c.reanchored) what.push("re-anchored");
      const name = c.renamed ? c.oldId + " → " + c.newId : c.newId;
      return name + " · " + what.join(", ");
    }),
  );
  add("Findings added", diff.findings.added.map(findingItem));
  add("Findings removed", diff.findings.removed.map(findingItem));
  add(
    "Findings moved",
    diff.findings.moved.map(
      (m) =>
        "[" + m.severity + "] " + m.concern + " · " +
        anchorText(m.from) + " → " + anchorText(m.to) + " — " + firstLine(m.text),
    ),
  );
  add("Files entering the changeset", diff.files.entering.slice());
  add("Files leaving the changeset", diff.files.leaving.slice());
  return sections;
}
