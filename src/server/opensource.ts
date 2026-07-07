import { execFile as nodeExecFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(nodeExecFile);

export type SourceOpenExec = (
  command: string,
  args: readonly string[],
) => Promise<void>;

export interface SourceOpenerSeams {
  exec?: SourceOpenExec;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const DEFAULT_EXEC: SourceOpenExec = async (command, args) => {
  await execFileAsync(command, [...args]);
};

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

function fileWithinRoot(root: string, file: string): string | null {
  if (file.trim() === "") return null;
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  // Symlink re-check: resolve through symlinks and verify containment again.
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }
  let realAbs: string;
  try {
    realAbs = realpathSync(abs);
  } catch {
    // File doesn't exist — no symlink to exploit; pass through as null-safe.
    return abs;
  }
  const realRel = path.relative(realRoot, realAbs);
  if (realRel === "" || realRel.startsWith("..") || path.isAbsolute(realRel)) return null;
  return abs;
}

export function createSourceOpener(
  worktreePath: string,
  seams: SourceOpenerSeams = {},
): (file: string, line: number) => Promise<boolean> {
  const root = path.resolve(worktreePath);
  const exec = seams.exec ?? DEFAULT_EXEC;
  const env = seams.env ?? process.env;
  const platform = seams.platform ?? process.platform;

  return async (file, line) => {
    if (!Number.isInteger(line) || line < 1) return false;
    const abs = fileWithinRoot(root, file);
    if (!abs) return false;

    const template = env.SLEEK_OPEN_CMD;
    if (template && template.trim() !== "") {
      // Tokenize FIRST, then substitute placeholders within each token so that
      // paths containing spaces are never split across multiple arguments.
      const tokens = tokenizeCommand(template);
      const parts = tokens.map((t) =>
        t.replaceAll("{file}", abs).replaceAll("{line}", String(line)),
      );
      if (parts.length > 0) {
        try {
          await exec(parts[0]!, parts.slice(1));
          return true;
        } catch {
          // fall through to default openers
        }
      }
    }

    try {
      await exec("code", ["-g", `${abs}:${line}`]);
      return true;
    } catch {
      // code not installed or failed; fall through on macOS.
    }

    if (platform === "darwin") {
      try {
        await exec("open", [abs]);
        return true;
      } catch {
        return false;
      }
    }

    return false;
  };
}
