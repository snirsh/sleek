/**
 * Wave-6 CLI argument parsing. Hand-rolled (no new deps), pure, tested.
 *
 * Parses `process.argv.slice(2)` into a typed ParsedArgs discriminated union.
 * Unknown flags or bad combos are returned as { command: "error", message }.
 */

export type ParsedArgs =
  | { command: "review"; pr: number; repo: string; port?: number; open: boolean; json: boolean; refresh: boolean; process: boolean }
  | { command: "connect"; repo: string; pr?: number; json: boolean }
  | { command: "review-pick"; repo: string; repoExplicit: boolean }
  | { command: "list"; repo: string; json: boolean }
  | { command: "regions"; pr: number; repo: string; json: boolean }
  | { command: "clean"; repo: string; yes: boolean }
  | { command: "finish"; pr: number; repo: string; yes: boolean }
  | { command: "help"; topic?: "review" | "connect" | "list" | "regions" | "clean" | "finish"; bare?: boolean }
  | { command: "error"; message: string };

/**
 * Parse an argv array (already sliced past the node/tsx/sleek binary) into a
 * typed ParsedArgs. Pure — no side-effects, fully testable.
 */
export function parseArgs(argv: string[], defaultRepo = process.cwd()): ParsedArgs {
  const [sub, ...rest] = argv;

  if (!sub) {
    return { command: "help", bare: true };
  }
  if (sub === "--help" || sub === "-h") {
    return { command: "help" };
  }

  const isCommand = sub === "review" || sub === "connect" || sub === "list" || sub === "regions" || sub === "clean" || sub === "finish";
  if (isCommand && rest.some((a) => a === "--help" || a === "-h")) {
    return { command: "help", topic: sub };
  }

  if (sub === "review") {
    return parseReview(rest, defaultRepo);
  }

  if (sub === "connect") {
    return parseConnect(rest, defaultRepo);
  }

  if (sub === "list") {
    return parseList(rest, defaultRepo);
  }

  if (sub === "regions") {
    return parseRegions(rest, defaultRepo);
  }

  if (sub === "clean") {
    return parseClean(rest, defaultRepo);
  }

  if (sub === "finish") {
    return parseFinish(rest, defaultRepo);
  }

  return { command: "error", message: `Unknown command: "${sub}". Run sleek --help for usage.` };
}

function parseConnect(argv: string[], defaultRepo: string): ParsedArgs {
  let repo = defaultRepo;
  let pr: number | undefined;
  let json = false;

  const iter = argv[Symbol.iterator]();
  for (const arg of iter) {
    if (arg === "--repo") {
      const val = iter.next().value as string | undefined;
      if (!val) return { command: "error", message: "--repo requires a value" };
      repo = val;
    } else if (arg === "--pr") {
      const val = iter.next().value as string | undefined;
      if (!val) return { command: "error", message: "--pr requires a value" };
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1) {
        return { command: "error", message: `--pr must be a positive integer, got: ${val}` };
      }
      pr = n;
    } else if (arg === "--json") {
      json = true;
    } else {
      return { command: "error", message: `Unknown flag: "${arg}". Run sleek connect --help for usage.` };
    }
  }

  return { command: "connect", repo, ...(pr !== undefined ? { pr } : {}), json };
}

function parseReview(argv: string[], defaultRepo: string): ParsedArgs {
  let prArg: string | undefined;
  let repo = defaultRepo;
  let repoExplicit = false;
  let port: number | undefined;
  let open = false;
  let json = false;
  let refresh = false;
  let process = false;

  const iter = argv[Symbol.iterator]();
  for (const arg of iter) {
    if (arg === "--repo") {
      const val = iter.next().value as string | undefined;
      if (!val) return { command: "error", message: "--repo requires a value" };
      repo = val;
      repoExplicit = true;
    } else if (arg === "--port") {
      const val = iter.next().value as string | undefined;
      if (!val) return { command: "error", message: "--port requires a value" };
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return { command: "error", message: `--port must be 1–65535, got: ${val}` };
      }
      port = n;
    } else if (arg === "--open") {
      open = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--refresh") {
      refresh = true;
    } else if (arg === "--process") {
      process = true;
    } else if (!arg.startsWith("-")) {
      if (prArg !== undefined) {
        return { command: "error", message: `Unexpected positional argument: "${arg}"` };
      }
      prArg = arg;
    } else {
      return { command: "error", message: `Unknown flag: "${arg}". Run sleek review --help for usage.` };
    }
  }

  if (prArg === undefined) {
    // No-arg review → interactive picker
    return { command: "review-pick", repo, repoExplicit };
  }

  const pr = Number(prArg);
  if (!Number.isInteger(pr) || pr < 1) {
    return { command: "error", message: `PR number must be a positive integer, got: "${prArg}"` };
  }

  return { command: "review", pr, repo, port, open, json, refresh, process };
}

function parseList(argv: string[], defaultRepo: string): ParsedArgs {
  let repo = defaultRepo;
  let json = false;

  const iter = argv[Symbol.iterator]();
  for (const arg of iter) {
    if (arg === "--repo") {
      const val = iter.next().value as string | undefined;
      if (!val) return { command: "error", message: "--repo requires a value" };
      repo = val;
    } else if (arg === "--json") {
      json = true;
    } else {
      return { command: "error", message: `Unknown flag: "${arg}". Run sleek list --help for usage.` };
    }
  }

  return { command: "list", repo, json };
}

function parseRegions(argv: string[], defaultRepo: string): ParsedArgs {
  let prArg: string | undefined;
  let repo = defaultRepo;
  let json = false;

  const iter = argv[Symbol.iterator]();
  for (const arg of iter) {
    if (arg === "--repo") {
      const val = iter.next().value as string | undefined;
      if (!val) return { command: "error", message: "--repo requires a value" };
      repo = val;
    } else if (arg === "--json") {
      json = true;
    } else if (!arg.startsWith("-")) {
      if (prArg !== undefined) {
        return { command: "error", message: `Unexpected positional argument: "${arg}"` };
      }
      prArg = arg;
    } else {
      return { command: "error", message: `Unknown flag: "${arg}". Run sleek regions --help for usage.` };
    }
  }

  if (prArg === undefined) {
    return { command: "error", message: "sleek regions requires a <pr> argument" };
  }

  const pr = Number(prArg);
  if (!Number.isInteger(pr) || pr < 1) {
    return { command: "error", message: `PR number must be a positive integer, got: "${prArg}"` };
  }

  return { command: "regions", pr, repo, json };
}

function parseClean(argv: string[], defaultRepo: string): ParsedArgs {
  let repo = defaultRepo;
  let yes = false;

  const iter = argv[Symbol.iterator]();
  for (const arg of iter) {
    if (arg === "--repo") {
      const val = iter.next().value as string | undefined;
      if (!val) return { command: "error", message: "--repo requires a value" };
      repo = val;
    } else if (arg === "--yes") {
      yes = true;
    } else {
      return { command: "error", message: `Unknown flag: "${arg}". Run sleek clean --help for usage.` };
    }
  }

  return { command: "clean", repo, yes };
}

function parseFinish(argv: string[], defaultRepo: string): ParsedArgs {
  let prArg: string | undefined;
  let repo = defaultRepo;
  let yes = false;

  const iter = argv[Symbol.iterator]();
  for (const arg of iter) {
    if (arg === "--repo") {
      const val = iter.next().value as string | undefined;
      if (!val) return { command: "error", message: "--repo requires a value" };
      repo = val;
    } else if (arg === "--yes") {
      yes = true;
    } else if (!arg.startsWith("-")) {
      if (prArg !== undefined) {
        return { command: "error", message: `Unexpected positional argument: "${arg}"` };
      }
      prArg = arg;
    } else {
      return { command: "error", message: `Unknown flag: "${arg}". Run sleek finish --help for usage.` };
    }
  }

  if (prArg === undefined) {
    return { command: "error", message: "sleek finish requires a <pr> argument" };
  }

  const pr = Number(prArg);
  if (!Number.isInteger(pr) || pr < 1) {
    return { command: "error", message: `PR number must be a positive integer, got: "${prArg}"` };
  }

  return { command: "finish", pr, repo, yes };
}
