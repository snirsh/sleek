/**
 * Shared helpers for e2e specs.
 *
 * The suite runs against a repo/PR of YOUR choosing, supplied via env vars
 * (see global-setup.ts for the full contract):
 *   SLEEK_E2E_REPO  absolute path to a local git checkout with a GitHub origin
 *   SLEEK_E2E_PR    a PR number in that repo with an authored review at
 *                   scripts/reviews/<pr>.json
 *
 * When these are unset every spec skips cleanly (see E2E_SKIP_MESSAGE).
 * Specs read E2E_BASE_URL (set by global-setup.ts) for the throwaway
 * server's address.
 */

export const E2E_REPO = process.env["SLEEK_E2E_REPO"];
export const PR_NUMBER = Number(process.env["SLEEK_E2E_PR"] ?? "0");

export const e2eConfigured = Boolean(E2E_REPO && PR_NUMBER > 0);

export const E2E_SKIP_MESSAGE =
  "e2e suite not configured: set SLEEK_E2E_REPO (local checkout path) and " +
  "SLEEK_E2E_PR (PR number with an authored review at scripts/reviews/<pr>.json)";

export function baseUrl(): string {
  const url = process.env["E2E_BASE_URL"];
  if (!url) throw new Error("E2E_BASE_URL not set — global-setup must have run first");
  return url;
}
