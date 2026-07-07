import { describe, expect, it } from "vitest";

import {
  defaultGhRunner,
  IngestError,
  ingestPr,
  resolveGhBinary,
  type GhRunner,
  type GitRunner,
} from "./ingest.ts";

// Fixture mirroring `gh pr view <n> --json number,title,body,baseRefName,baseRefOid,headRefOid,files`.
const PR_VIEW_FIXTURE = JSON.stringify({
  number: 42,
  title: "Add rate limiter",
  body: "Introduces a token-bucket rate limiter.\n\nCloses #10.",
  baseRefName: "main",
  baseRefOid: "base1111111111111111111111111111111111111",
  headRefOid: "head2222222222222222222222222222222222222",
  files: [
    { path: "src/limiter.ts", additions: 40, deletions: 0 },
    { path: "src/limiter.test.ts", additions: 25, deletions: 0 },
    { path: "README.md", additions: 3, deletions: 1 },
  ],
});

const DIFF_FIXTURE = `diff --git a/src/limiter.ts b/src/limiter.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/limiter.ts
@@ -0,0 +1,3 @@
+export class Limiter {}
`;

/** Build a fake GhRunner that dispatches on the gh subcommand. */
function fakeGh(overrides?: {
  view?: string;
  diff?: string;
  repoView?: string;
  onView?: () => never;
}): GhRunner {
  return async (args) => {
    if (args[0] === "pr" && args[1] === "view") {
      if (overrides?.onView) overrides.onView();
      return overrides?.view ?? PR_VIEW_FIXTURE;
    }
    if (args[0] === "pr" && args[1] === "diff") return overrides?.diff ?? DIFF_FIXTURE;
    if (args[0] === "repo" && args[1] === "view")
      return overrides?.repoView ?? JSON.stringify({ defaultBranchRef: { name: "main" } });
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
}

describe("ingestPr", () => {
  it("resolves gh from an explicit env override", () => {
    expect(
      resolveGhBinary({
        env: { SLEEK_GH_BIN: "/custom/bin/gh" },
        fileExists: () => false,
      }),
    ).toBe("/custom/bin/gh");
  });

  it("falls back to common Homebrew gh locations when PATH is thin", () => {
    expect(
      resolveGhBinary({
        env: {},
        fileExists: (path) => path === "/opt/homebrew/bin/gh",
      }),
    ).toBe("/opt/homebrew/bin/gh");
  });

  it("throws repo-not-found when the requested repo path is missing", async () => {
    const err = await defaultGhRunner(
      ["--version"],
      "/tmp/sleek-missing-repo-path",
    ).catch((e) => e);

    expect(err).toBeInstanceOf(IngestError);
    expect((err as IngestError).kind).toBe("repo-not-found");
  });

  it("maps gh output to a ChangeSet", async () => {
    const cs = await ingestPr(42, { gh: fakeGh(), cwd: "/repo" });

    expect(cs.pr).toEqual({
      number: 42,
      title: "Add rate limiter",
      description: "Introduces a token-bucket rate limiter.\n\nCloses #10.",
      baseSha: "base1111111111111111111111111111111111111",
      headSha: "head2222222222222222222222222222222222222",
      stackedOnto: null,
    });
    expect(cs.files).toEqual([
      "src/limiter.ts",
      "src/limiter.test.ts",
      "README.md",
    ]);
    expect(cs.unifiedDiff).toBe(DIFF_FIXTURE);
    expect(cs.noiseFiles).toEqual([]);
  });

  it("passes the PR number and cwd through to the runner", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const recordingGh: GhRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      if (args[0] === "pr" && args[1] === "view") return PR_VIEW_FIXTURE;
      if (args[0] === "pr" && args[1] === "diff") return DIFF_FIXTURE;
      if (args[0] === "repo") return JSON.stringify({ defaultBranchRef: { name: "main" } });
      throw new Error(`unexpected: ${args.join(" ")}`);
    };

    await ingestPr(7, { gh: recordingGh, cwd: "/some/clone" });

    expect(calls[0]).toEqual({
      args: [
        "pr",
        "view",
        "7",
        "--json",
        "number,title,body,baseRefName,baseRefOid,headRefOid,files",
      ],
      cwd: "/some/clone",
    });
    expect(calls[1]).toEqual({ args: ["pr", "diff", "7"], cwd: "/some/clone" });
  });

  it("throws a typed pr-not-found error when the runner reports it", async () => {
    const notFoundGh = fakeGh({
      onView: () => {
        throw new IngestError("pr-not-found", "No pull request found for #999.");
      },
    });

    const err = await ingestPr(999, { gh: notFoundGh }).catch((e) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect((err as IngestError).kind).toBe("pr-not-found");
  });

  it("throws bad-output on malformed JSON", async () => {
    const err = await ingestPr(1, {
      gh: fakeGh({ view: "not json" }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect((err as IngestError).kind).toBe("bad-output");
  });

  it("throws bad-output when required fields are missing", async () => {
    const err = await ingestPr(1, {
      gh: fakeGh({ view: JSON.stringify({ number: 1, title: "x" }) }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect((err as IngestError).kind).toBe("bad-output");
  });

  it("uses merge-base git diff when git runner is provided", async () => {
    const GIT_DIFF = `diff --git a/src/limiter.ts b/src/limiter.ts
--- a/src/limiter.ts
+++ b/src/limiter.ts
@@ -1,1 +1,2 @@
+// git-diff line
 export class Limiter {}
`;
    const fakeGit: GitRunner = async (args) => {
      if (args[0] === "merge-base") return "mergebasesha\n";
      if (args[0] === "diff") return GIT_DIFF;
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    };
    const cs = await ingestPr(42, { gh: fakeGh(), git: fakeGit, cwd: "/repo" });
    expect(cs.unifiedDiff).toBe(GIT_DIFF);
  });

  it("falls back to gh pr diff when git runner throws", async () => {
    const throwingGit: GitRunner = async () => {
      throw new Error("shallow clone");
    };
    const cs = await ingestPr(42, { gh: fakeGh(), git: throwingGit, cwd: "/repo" });
    expect(cs.unifiedDiff).toBe(DIFF_FIXTURE);
  });

  it("rejects refs that are not safe git arguments (bad-output)", async () => {
    const fixture = JSON.stringify({
      ...(JSON.parse(PR_VIEW_FIXTURE) as object),
      headRefOid: "--upload-pack=evil",
    });
    const err = await ingestPr(42, {
      gh: fakeGh({ view: fixture }),
      cwd: "/repo",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect((err as IngestError).kind).toBe("bad-output");
  });

  it("falls back to gh pr diff when merge-base output is not a safe ref", async () => {
    const fakeGit: GitRunner = async (args) => {
      if (args[0] === "merge-base") return "--not-a-sha\n";
      return "should not be used";
    };
    const cs = await ingestPr(42, { gh: fakeGh(), git: fakeGit, cwd: "/repo" });
    expect(cs.unifiedDiff).toBe(DIFF_FIXTURE);
  });

  it("sets stackedOnto when baseRefName differs from default branch", async () => {
    const fixture = JSON.stringify({
      number: 42,
      title: "Stacked PR",
      body: "stacked",
      baseRefName: "feature/base",
      baseRefOid: "base1111111111111111111111111111111111111",
      headRefOid: "head2222222222222222222222222222222222222",
      files: [],
    });
    const cs = await ingestPr(42, {
      gh: fakeGh({ view: fixture }),
      cwd: "/repo",
    });
    expect(cs.pr.stackedOnto).toBe("feature/base");
  });

  it("sets stackedOnto to null when baseRefName equals default branch", async () => {
    const cs = await ingestPr(42, { gh: fakeGh(), cwd: "/repo" });
    expect(cs.pr.stackedOnto).toBeNull();
  });
});
