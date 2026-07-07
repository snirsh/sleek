/**
 * Back-compat shim: the renderer was promoted from this script into src/render/
 * (diffmodel.ts · highlight.ts · intraline.ts · html.ts · client.ts) once it grew
 * past ~1k lines (docs/UI-ROADMAP.md, "Constraints"). Import from src/render/html.ts
 * in new code; this re-export keeps existing scripts/demo-review.ts / serve-demo.ts
 * imports working unchanged.
 */
export { parseUnifiedDiff, renderReviewHtml } from "../src/render/html.ts";
