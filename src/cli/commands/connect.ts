import { defaultGhRunner, type GhRunner } from "../../ingest/ingest.ts";
import { findActiveServer, normalizeRepoPath } from "../registry.ts";

export interface ConnectOptions {
  repo: string;
  pr?: number;
  json: boolean;
}

export interface ConnectCommandDeps {
  gh?: GhRunner;
  findServer?: typeof findActiveServer;
}

interface GhPrNumber {
  number?: unknown;
}

const SKILL_AGENT_INSTALLS = {
  codex: "npx skills add . --skill sleek-agent --agent codex --global",
  claudeCode: "npx skills add . --skill sleek-agent --agent claude-code --global",
  cursor: "npx skills add . --skill sleek-agent --agent cursor --global",
};

const SKILL_SOURCE_INSTALLS = {
  codex: "npx skills add <owner>/<repo> --skill sleek-agent --agent codex --global",
  claudeCode: "npx skills add <owner>/<repo> --skill sleek-agent --agent claude-code --global",
  cursor: "npx skills add <owner>/<repo> --skill sleek-agent --agent cursor --global",
};

async function inferCurrentPr(repo: string, gh: GhRunner): Promise<number> {
  const raw = await gh(["pr", "view", "--json", "number"], repo);
  let parsed: GhPrNumber;
  try {
    parsed = JSON.parse(raw) as GhPrNumber;
  } catch {
    throw new Error("Could not parse `gh pr view --json number` output.");
  }
  if (typeof parsed.number !== "number" || !Number.isInteger(parsed.number) || parsed.number < 1) {
    throw new Error("`gh pr view --json number` did not return a valid PR number.");
  }
  return parsed.number;
}

export async function runConnect(
  opts: ConnectOptions,
  deps: ConnectCommandDeps = {},
): Promise<void> {
  const repo = normalizeRepoPath(opts.repo);
  const gh = deps.gh ?? defaultGhRunner;
  const pr = opts.pr ?? await inferCurrentPr(repo, gh);
  const findServer = deps.findServer ?? findActiveServer;
  const entry = await findServer({ repo, pr });
  if (!entry) {
    process.stderr.write(`No active Sleek server found for ${repo} PR #${pr}.\n`);
    process.exit(1);
    return;
  }

  const output = {
    url: entry.url,
    repo: entry.repo,
    pr: entry.pr,
    headSha: entry.headSha,
    startedAt: entry.startedAt,
    agent: {
      context: `${entry.url}/api/agent/context`,
      comments: `${entry.url}/api/agent/comments`,
      createComment: `POST ${entry.url}/api/agent/comments`,
      setVisibility: `POST ${entry.url}/api/agent/comments/:id/visibility`,
      note: "Agent-created comments are local drafts until a human changes visibility and submits.",
    },
    skill: {
      name: "sleek-agent",
      localInstall: SKILL_AGENT_INSTALLS,
      sourceInstall: SKILL_SOURCE_INSTALLS,
    },
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(output) + "\n");
    return;
  }

  process.stdout.write(
    [
      `Sleek server: ${output.url}`,
      `PR: #${output.pr}`,
      `Head SHA: ${output.headSha}`,
      "Agent endpoints:",
      `  ${output.agent.context}`,
      `  ${output.agent.comments}`,
      `  ${output.agent.createComment}`,
      `  ${output.agent.setVisibility}`,
      "Agent skill:",
      `  Codex: ${output.skill.localInstall.codex}`,
      `  Claude Code: ${output.skill.localInstall.claudeCode}`,
      `  Cursor: ${output.skill.localInstall.cursor}`,
    ].join("\n") + "\n",
  );
}
