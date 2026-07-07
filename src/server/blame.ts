import path from "node:path";

import { simpleGit, type SimpleGit } from "simple-git";

export interface BlameInfo {
  sha: string;
  shortSha: string;
  author: string;
  authorDate: string;
  summary: string;
}

export type BlameSide = "LEFT" | "RIGHT";

export interface BlameRequest {
  file: string;
  side: BlameSide;
  line: number;
}

interface GitRaw {
  raw(args: string[]): Promise<string>;
}

export interface GitBlamerOptions {
  baseSha: string;
  headSha: string;
}

export interface GitBlamerSeams {
  git?: GitRaw;
}

function isSafeRelativePath(file: string): boolean {
  if (file.trim() === "" || path.isAbsolute(file)) return false;
  return !file.split(/[\\/]+/).some((part) => part === "..");
}

function parsePorcelain(output: string): BlameInfo | null {
  const lines = output.split(/\r?\n/);
  const first = lines[0]?.trim();
  const sha = first?.split(/\s+/)[0];
  if (!sha) return null;

  let author = "";
  let authorTime: number | null = null;
  let summary = "";

  for (const line of lines.slice(1)) {
    if (line.startsWith("author ")) {
      author = line.slice("author ".length);
    } else if (line.startsWith("author-time ")) {
      const parsed = Number(line.slice("author-time ".length));
      authorTime = Number.isFinite(parsed) ? parsed : null;
    } else if (line.startsWith("summary ")) {
      summary = line.slice("summary ".length);
    }
  }

  if (!author || authorTime === null) return null;
  return {
    sha,
    shortSha: sha.slice(0, 12),
    author,
    authorDate: new Date(authorTime * 1000).toISOString(),
    summary,
  };
}

export function createGitBlamer(
  repoPath: string,
  options: GitBlamerOptions,
  seams: GitBlamerSeams = {},
): (req: BlameRequest) => Promise<BlameInfo | null> {
  const git: GitRaw = seams.git ?? (simpleGit(repoPath) as SimpleGit);

  return async (req) => {
    if (
      !isSafeRelativePath(req.file) ||
      !Number.isInteger(req.line) ||
      req.line < 1
    ) {
      return null;
    }

    const sha = req.side === "LEFT" ? options.baseSha : options.headSha;
    try {
      const out = await git.raw([
        "blame",
        "--porcelain",
        "-L",
        `${req.line},${req.line}`,
        sha,
        "--",
        req.file,
      ]);
      return parsePorcelain(out);
    } catch {
      return null;
    }
  };
}
