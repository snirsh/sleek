# Authored replay reviews

Drop authored reviews here as `<prNumber>.json`. When present, the demo pipeline
(`scripts/serve-demo.ts`, `scripts/demo-review.ts`) replays the file as the
Scaffolder LLM's output — no Anthropic API key needed.

To author one:

1. Print the real changed regions the skeleton must tile:
   `npx tsx scripts/dump-regions.ts <repoPath> <prNumber>`
2. Write `<prNumber>.json` in the format documented (with a full synthetic
   example) above `loadAuthoredReviewJson()` in `scripts/demo-data.ts`.
