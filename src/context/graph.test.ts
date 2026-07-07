/**
 * Tests for B3 graph-aware grouping (src/context/graph.ts).
 */

import { describe, expect, it, vi } from "vitest";
import { buildGraph } from "./graph.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NX_GRAPH_JSON = {
  graph: {
    nodes: {
      "@app/web": { data: { root: "apps/web" } },
      "@lib/utils": { data: { root: "libs/utils" } },
      "@lib/api": { data: { root: "libs/api" } },
    },
    dependencies: {
      "@app/web": [
        { source: "@app/web", target: "@lib/utils", type: "static" },
        { source: "@app/web", target: "@lib/api", type: "static" },
      ],
      "@lib/api": [{ source: "@lib/api", target: "@lib/utils", type: "static" }],
      "@lib/utils": [],
    },
  },
};

const TURBO_GRAPH_JSON = {
  tasks: [
    {
      taskId: "@app/web#build",
      package: "@app/web",
      directory: "apps/web",
      dependencies: ["@lib/utils#build", "@lib/api#build"],
    },
    {
      taskId: "@lib/api#build",
      package: "@lib/api",
      directory: "libs/api",
      dependencies: ["@lib/utils#build"],
    },
    {
      taskId: "@lib/utils#build",
      package: "@lib/utils",
      directory: "libs/utils",
      dependencies: [],
    },
  ],
};

const WORKTREE = "/repo";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Make a runner that simulates nx: writes the graph JSON to the --file= path. */
function makeNxRunner(json: unknown): (cmd: string, cwd: string) => Promise<string> {
  return async (cmd: string, _cwd: string) => {
    // nx graph writes to --file=<path>
    const match = /--file=(\S+)/.exec(cmd);
    if (match) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(match[1]!, JSON.stringify(json), "utf8");
    }
    return "";
  };
}

/** Make a runner that returns the JSON string as stdout (turbo). */
function makeTurboRunner(json: unknown): (cmd: string, cwd: string) => Promise<string> {
  return async (_cmd: string, _cwd: string) => JSON.stringify(json);
}

/** Make a runner that always throws. */
function makeFailRunner(): (cmd: string, cwd: string) => Promise<string> {
  return async () => {
    throw new Error("command failed");
  };
}

// ── nx graph parsing ──────────────────────────────────────────────────────────

describe("buildGraph — nx fixture", () => {
  it("maps files to projects using most-specific root match", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = await mkdtemp(join(tmpdir(), "sleek-graph-test-"));
    try {
      // Create nx.json so the tool is detected
      await writeFile(join(tmpDir, "nx.json"), "{}", "utf8");

      const changedFiles = [
        join(tmpDir, "apps/web/src/main.ts"),
        join(tmpDir, "libs/utils/index.ts"),
        join(tmpDir, "libs/api/client.ts"),
      ];

      const result = await buildGraph(tmpDir, changedFiles, undefined, makeNxRunner(NX_GRAPH_JSON));

      expect(result).not.toBeNull();
      expect(result!.fileProject[changedFiles[0]!]).toBe("@app/web");
      expect(result!.fileProject[changedFiles[1]!]).toBe("@lib/utils");
      expect(result!.fileProject[changedFiles[2]!]).toBe("@lib/api");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("builds edges from dependencies", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = await mkdtemp(join(tmpdir(), "sleek-graph-test-"));
    try {
      await writeFile(join(tmpDir, "nx.json"), "{}", "utf8");

      const changedFiles = [
        join(tmpDir, "apps/web/src/main.ts"),
        join(tmpDir, "libs/utils/index.ts"),
      ];

      const result = await buildGraph(tmpDir, changedFiles, undefined, makeNxRunner(NX_GRAPH_JSON));

      expect(result).not.toBeNull();
      expect(result!.edges).toContainEqual({ from: "@app/web", to: "@lib/utils" });
      expect(result!.edges).toContainEqual({ from: "@app/web", to: "@lib/api" });
      expect(result!.edges).toContainEqual({ from: "@lib/api", to: "@lib/utils" });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("computes centrality: @lib/utils has highest degree", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = await mkdtemp(join(tmpdir(), "sleek-graph-test-"));
    try {
      await writeFile(join(tmpDir, "nx.json"), "{}", "utf8");

      const changedFiles = [
        join(tmpDir, "apps/web/src/main.ts"),
        join(tmpDir, "libs/utils/index.ts"),
        join(tmpDir, "libs/api/client.ts"),
      ];

      const result = await buildGraph(tmpDir, changedFiles, undefined, makeNxRunner(NX_GRAPH_JSON));

      expect(result).not.toBeNull();
      // @lib/utils is depended on by both @app/web and @lib/api → highest in-degree
      const utilsCentrality = result!.centralityByFile[changedFiles[1]!]!;
      const webCentrality = result!.centralityByFile[changedFiles[0]!]!;
      expect(utilsCentrality).toBeGreaterThan(0);
      expect(utilsCentrality).toBeGreaterThanOrEqual(webCentrality);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("builds clusters from regionFileMap", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = await mkdtemp(join(tmpdir(), "sleek-graph-test-"));
    try {
      await writeFile(join(tmpDir, "nx.json"), "{}", "utf8");

      const changedFiles = [
        join(tmpDir, "apps/web/src/main.ts"),
        join(tmpDir, "libs/utils/index.ts"),
      ];

      const regionFileMap = [
        { file: changedFiles[0]!, regionIndex: 0 },
        { file: changedFiles[0]!, regionIndex: 1 },
        { file: changedFiles[1]!, regionIndex: 2 },
      ];

      const result = await buildGraph(tmpDir, changedFiles, regionFileMap, makeNxRunner(NX_GRAPH_JSON));

      expect(result).not.toBeNull();
      const webCluster = result!.clusters.find((c) => c.project === "@app/web");
      const utilsCluster = result!.clusters.find((c) => c.project === "@lib/utils");
      expect(webCluster?.regionIndexes).toEqual([0, 1]);
      expect(utilsCluster?.regionIndexes).toEqual([2]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── turbo graph parsing ───────────────────────────────────────────────────────

describe("buildGraph — turbo fixture", () => {
  it("maps files to packages using directory field", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = await mkdtemp(join(tmpdir(), "sleek-graph-test-"));
    try {
      await writeFile(join(tmpDir, "turbo.json"), "{}", "utf8");

      const changedFiles = [
        join(tmpDir, "apps/web/src/main.ts"),
        join(tmpDir, "libs/utils/index.ts"),
        join(tmpDir, "libs/api/client.ts"),
      ];

      const result = await buildGraph(tmpDir, changedFiles, undefined, makeTurboRunner(TURBO_GRAPH_JSON));

      expect(result).not.toBeNull();
      expect(result!.fileProject[changedFiles[0]!]).toBe("@app/web");
      expect(result!.fileProject[changedFiles[1]!]).toBe("@lib/utils");
      expect(result!.fileProject[changedFiles[2]!]).toBe("@lib/api");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("builds edges from task dependencies (pkg#task format stripped)", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = await mkdtemp(join(tmpdir(), "sleek-graph-test-"));
    try {
      await writeFile(join(tmpDir, "turbo.json"), "{}", "utf8");

      const changedFiles = [join(tmpDir, "apps/web/src/main.ts")];

      const result = await buildGraph(tmpDir, changedFiles, undefined, makeTurboRunner(TURBO_GRAPH_JSON));

      expect(result).not.toBeNull();
      expect(result!.edges).toContainEqual({ from: "@app/web", to: "@lib/utils" });
      expect(result!.edges).toContainEqual({ from: "@app/web", to: "@lib/api" });
      expect(result!.edges).toContainEqual({ from: "@lib/api", to: "@lib/utils" });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── fail-soft cases ───────────────────────────────────────────────────────────

describe("buildGraph — fail-soft", () => {
  it("returns null when no nx.json or turbo.json", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = await mkdtemp(join(tmpdir(), "sleek-graph-test-"));
    try {
      const result = await buildGraph(tmpDir, ["src/foo.ts"], undefined, makeFailRunner());
      expect(result).toBeNull();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when the graph command fails", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = await mkdtemp(join(tmpdir(), "sleek-graph-test-"));
    try {
      await writeFile(join(tmpDir, "turbo.json"), "{}", "utf8");
      const result = await buildGraph(tmpDir, ["src/foo.ts"], undefined, makeFailRunner());
      expect(result).toBeNull();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when turbo output is not valid JSON", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = await mkdtemp(join(tmpdir(), "sleek-graph-test-"));
    try {
      await writeFile(join(tmpDir, "turbo.json"), "{}", "utf8");
      const badRunner = async (): Promise<string> => "not json at all {{{{";
      const result = await buildGraph(tmpDir, ["src/foo.ts"], undefined, badRunner);
      expect(result).toBeNull();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when turbo JSON lacks tasks array", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = await mkdtemp(join(tmpdir(), "sleek-graph-test-"));
    try {
      await writeFile(join(tmpDir, "turbo.json"), "{}", "utf8");
      const badRunner = async (): Promise<string> => JSON.stringify({ notTasks: [] });
      const result = await buildGraph(tmpDir, ["src/foo.ts"], undefined, badRunner);
      expect(result).toBeNull();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── centrality normalization ───────────────────────────────────────────────────

describe("centrality normalization", () => {
  it("all-isolated projects have centrality 0", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = await mkdtemp(join(tmpdir(), "sleek-graph-test-"));
    try {
      await writeFile(join(tmpDir, "turbo.json"), "{}", "utf8");
      const noEdgesJson = {
        tasks: [
          { taskId: "a#build", package: "a", directory: "packages/a", dependencies: [] },
          { taskId: "b#build", package: "b", directory: "packages/b", dependencies: [] },
        ],
      };
      const changedFiles = [
        join(tmpDir, "packages/a/index.ts"),
        join(tmpDir, "packages/b/index.ts"),
      ];
      const result = await buildGraph(tmpDir, changedFiles, undefined, makeTurboRunner(noEdgesJson));
      expect(result).not.toBeNull();
      expect(result!.centralityByFile[changedFiles[0]!]).toBe(0);
      expect(result!.centralityByFile[changedFiles[1]!]).toBe(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("most-connected project has centrality 1", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tmpDir = await mkdtemp(join(tmpdir(), "sleek-graph-test-"));
    try {
      await writeFile(join(tmpDir, "turbo.json"), "{}", "utf8");

      const changedFiles = [
        join(tmpDir, "apps/web/src/main.ts"),
        join(tmpDir, "libs/utils/index.ts"),
        join(tmpDir, "libs/api/client.ts"),
      ];

      const result = await buildGraph(tmpDir, changedFiles, undefined, makeTurboRunner(TURBO_GRAPH_JSON));

      expect(result).not.toBeNull();
      // @lib/utils: depended on by @app/web (1) and @lib/api (1) = 2 in-edges, 0 out = degree 2
      // @lib/api: 1 out-edge to @lib/utils, 1 in-edge from @app/web = degree 2
      // @app/web: 2 out-edges, 0 in = degree 2
      // All have degree 2, so all normalized to 1
      const utils = result!.centralityByFile[changedFiles[1]!]!;
      expect(utils).toBe(1);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
