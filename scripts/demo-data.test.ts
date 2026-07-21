import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChangeSet, ReviewScaffold } from "../src/domain/scaffold.ts";
import { runWorker } from "../src/review/pipeline.ts";

vi.mock("node:child_process", () => ({
  fork: vi.fn(),
}));

type MockChild = EventEmitter & {
  stderr: EventEmitter;
  pid?: number;
};

const forkMock = vi.mocked(fork);

let root: string;

function makeChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stderr = new EventEmitter();
  return child;
}

function mockForkedChild(): MockChild {
  const child = makeChild();
  forkMock.mockReturnValue(child as never);
  return child;
}

function workerConfig() {
  return {
    repoPath: root,
    prNumber: 123,
    choice: { kind: "replay" as const },
    cacheDb: join(root, "cache.db"),
  };
}

function workerResult() {
  const changeSet: ChangeSet = {
    pr: {
      number: 123,
      title: "PR",
      description: "",
      baseSha: "base",
      headSha: "head",
    },
    unifiedDiff: "",
    files: [],
  };
  const scaffold: ReviewScaffold = { pr: changeSet.pr, layers: [] };
  return { changeSet, scaffold, layerTitles: { layer1: "Layer 1" } };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sleek-demo-data-test-"));
  forkMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("runWorker", () => {
  it("reads a result temp file and deletes it", async () => {
    const child = mockForkedChild();
    const resultPath = join(root, "result.json");
    const expected = workerResult();
    writeFileSync(resultPath, JSON.stringify(expected));

    const promise = runWorker(workerConfig(), vi.fn(), undefined);
    child.emit("message", { type: "result", path: resultPath });
    child.emit("exit", 0, null);

    await expect(promise).resolves.toEqual(expected);
    expect(existsSync(resultPath)).toBe(false);
  });

  it("still accepts the legacy inline result message", async () => {
    const child = mockForkedChild();
    const expected = workerResult();

    const promise = runWorker(workerConfig(), vi.fn(), undefined);
    child.emit("message", { type: "result", ...expected });
    child.emit("exit", 0, null);

    await expect(promise).resolves.toEqual(expected);
  });

  it("rejects clearly when the result temp file is missing", async () => {
    const child = mockForkedChild();
    const resultPath = join(root, "missing-result.json");

    const promise = runWorker(workerConfig(), vi.fn(), undefined);
    child.emit("message", { type: "result", path: resultPath });

    await expect(promise).rejects.toThrow(
      `scaffold worker result file missing or unreadable at ${resultPath}`,
    );
  });
});
