/**
 * Wave-6 CLI main entry point. Parses args and dispatches to command handlers.
 * Imported by scripts/sleek.ts (the #!/usr/bin/env tsx shim).
 */

import { parseArgs } from "./args.ts";
import { printHelp } from "./help.ts";
import { runReview } from "./commands/review.ts";
import { runPick } from "./commands/pick.ts";
import { runList } from "./commands/list.ts";
import { runRegions } from "./commands/regions.ts";
import { runClean } from "./commands/clean.ts";
import { runFinish } from "./commands/finish.ts";
import { runConnect } from "./commands/connect.ts";

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);

  switch (parsed.command) {
    case "help":
      printHelp(parsed.topic);
      // Bare `sleek` (no args at all) exits 1; explicit --help exits 0.
      process.exit(parsed.bare ? 1 : 0);
      return;

    case "error":
      process.stderr.write(
        parsed.message.includes("--help")
          ? `${parsed.message}\n`
          : `${parsed.message}\nRun sleek --help for usage.\n`,
      );
      process.exit(1);
      return;

    case "review":
      await runReview(parsed);
      return;

    case "connect":
      await runConnect(parsed);
      return;

    case "review-pick":
      await runPick({ repo: parsed.repo, repoExplicit: parsed.repoExplicit });
      return;

    case "list":
      await runList(parsed);
      process.exit(0);
      return;

    case "regions":
      await runRegions(parsed);
      process.exit(0);
      return;

    case "clean":
      await runClean(parsed);
      process.exit(0);
      return;

    case "finish":
      await runFinish(parsed);
      process.exit(0);
      return;

    default: {
      // Exhaustiveness check
      const _never: never = parsed;
      void _never;
      process.stderr.write("Unknown command.\n");
      process.exit(1);
    }
  }
}
