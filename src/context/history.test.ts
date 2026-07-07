import { describe, it, expect } from "vitest";
import { parseLogOutput, regionHistory, type GitRunner } from "./history.ts";

// The record/field separators regionHistory asks git to emit (\x1e / \x1f).
const R = "\x1e";
const F = "\x1f";

describe("parseLogOutput", () => {
  it("parses multiple commit records", () => {
    const out = `${F}abc123${F}Fix the limiter${F}3 days ago${R}\n${F}def456${F}Add limiter${F}2 weeks ago${R}\n`;
    expect(parseLogOutput(out)).toEqual([
      { sha: "abc123", subject: "Fix the limiter", whenRelevant: "3 days ago" },
      { sha: "def456", subject: "Add limiter", whenRelevant: "2 weeks ago" },
    ]);
  });

  it("returns [] for empty output", () => {
    expect(parseLogOutput("")).toEqual([]);
  });
});

describe("regionHistory (injected runner)", () => {
  it("passes a git log -L range and bounds the count", async () => {
    let captured: string[] = [];
    const runner: GitRunner = async (_wt, args) => {
      captured = args;
      return `${F}s1${F}subject one${F}1 hour ago${R}\n${F}s2${F}subject two${F}2 hours ago${R}\n${F}s3${F}subject three${F}3 hours ago${R}\n`;
    };
    const result = await regionHistory("/wt", "src/x.ts", 10, 20, 2, runner);
    expect(captured).toContain("-L10,20:src/x.ts");
    expect(captured).toContain("--max-count=2");
    // bounded to the limit
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ sha: "s1", subject: "subject one", whenRelevant: "1 hour ago" });
  });

  it("returns [] when the git runner throws", async () => {
    const runner: GitRunner = async () => {
      throw new Error("no such path in HEAD");
    };
    expect(await regionHistory("/wt", "missing.ts", 1, 5, 5, runner)).toEqual([]);
  });
});
