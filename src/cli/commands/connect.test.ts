import { afterEach, describe, expect, it, vi } from "vitest";

import { runConnect } from "./connect.ts";
import type { GhRunner } from "../../ingest/ingest.ts";

describe("runConnect", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("infers the current PR from gh and prints the active server as JSON", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const gh: GhRunner = async (args) => {
      expect(args).toEqual(["pr", "view", "--json", "number"]);
      return JSON.stringify({ number: 42 });
    };

    await runConnect(
      { repo: ".", json: true },
      {
        gh,
        findServer: async ({ pr }) => ({
          url: "http://localhost:4444",
          repo: process.cwd(),
          pr,
          headSha: "abc123",
          startedAt: "2026-01-01T00:00:00Z",
        }),
      },
    );

    const output = JSON.parse(writes.join("")) as {
      url: string;
      pr: number;
      agent: { context: string };
      skill: {
        name: string;
        localInstall: { codex: string; claudeCode: string; cursor: string };
      };
    };
    expect(output.url).toBe("http://localhost:4444");
    expect(output.pr).toBe(42);
    expect(output.agent.context).toBe("http://localhost:4444/api/agent/context");
    expect(output.skill).toMatchObject({
      name: "sleek-agent",
      localInstall: {
        codex: "npx skills add . --skill sleek-agent --agent codex --global",
        claudeCode: "npx skills add . --skill sleek-agent --agent claude-code --global",
        cursor: "npx skills add . --skill sleek-agent --agent cursor --global",
      },
    });
  });
});
