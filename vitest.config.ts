import { defineConfig, configDefaults } from "vitest/config";

// Playwright e2e specs live in e2e/ and run via `npm run test:e2e`;
// keep them out of vitest's default *.spec.ts glob. Agent scratch worktrees
// under .claude/ can contain stale copies of tests and should not be collected.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e/**", ".claude/**"],
  },
});
