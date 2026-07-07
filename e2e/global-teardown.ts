/**
 * Playwright global teardown: kill the throwaway demo server and clean up the
 * scratch directory that was created in global-setup.ts.
 */

import { rmSync } from "node:fs";

export default async function globalTeardown(): Promise<void> {
  const pid = process.env["E2E_SERVER_PID"];
  const scratchDir = process.env["E2E_SCRATCH_DIR"];

  if (pid) {
    try {
      process.kill(Number(pid), "SIGTERM");
      console.log(`[e2e teardown] killed server pid ${pid}`);
    } catch {
      // Already dead — fine.
    }
  }

  if (scratchDir) {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
      console.log(`[e2e teardown] removed scratch dir ${scratchDir}`);
    } catch (e) {
      console.warn("[e2e teardown] could not remove scratch dir:", e);
    }
  }
}
