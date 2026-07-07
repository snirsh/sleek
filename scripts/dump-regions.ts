/**
 * Authoring aid (not part of the product build). Prints, as JSON, the REAL changed
 * regions (anchors) the Scaffolder's skeleton must tile for a PR — real gh ingest (M1)
 * → real diff-region parsing (M2 diff.ts). Use this before authoring a replayed review
 * (scripts/reviews/<pr>.json): the anchors you author must match these regions exactly.
 *
 * Run: npx tsx scripts/dump-regions.ts <repoPath> <prNumber>
 */
import { parseChangedRegions } from "../src/context/diff.ts";
import { ingestPr } from "../src/ingest/ingest.ts";

const [repoPath, prArg] = process.argv.slice(2);
if (!repoPath || !prArg) {
  console.error("usage: tsx scripts/dump-regions.ts <repoPath> <prNumber>");
  process.exit(1);
}

const changeSet = await ingestPr(Number(prArg), { cwd: repoPath });
const regions = parseChangedRegions(changeSet.unifiedDiff);
console.log(
  JSON.stringify(
    {
      pr: { number: changeSet.pr.number, title: changeSet.pr.title, headSha: changeSet.pr.headSha },
      regions: regions.map((r) => ({
        file: r.file,
        side: r.side,
        startLine: r.startLine,
        endLine: r.endLine,
      })),
    },
    null,
    2,
  ),
);
