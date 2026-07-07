#!/usr/bin/env -S npx tsx
/**
 * Sleek CLI entry shim. Invoked as `npx tsx scripts/sleek.ts` or (after `npm link`) as `sleek`.
 * All logic lives in src/cli/main.ts.
 */
import { main } from "../src/cli/main.ts";

await main();
