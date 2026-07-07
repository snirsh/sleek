import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findActiveServer,
  readRegistry,
  registerServer,
  unregisterServer,
} from "./registry.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempRegistry(): string {
  const dir = mkdtempSync(join(tmpdir(), "sleek-registry-"));
  tempDirs.push(dir);
  return join(dir, "servers.json");
}

describe("server registry", () => {
  it("registers and unregisters server entries scoped by repo, PR, and SHA", () => {
    const registryPath = tempRegistry();
    registerServer({
      url: "http://localhost:4000",
      repo: ".",
      pr: 1,
      headSha: "abc",
      startedAt: "2026-01-01T00:00:00Z",
    }, { registryPath });

    expect(readRegistry({ registryPath }).entries).toHaveLength(1);
    unregisterServer({ repo: ".", pr: 1, headSha: "abc" }, { registryPath });
    expect(readRegistry({ registryPath }).entries).toEqual([]);
  });

  it("findActiveServer ignores stale entries and keeps live entries", async () => {
    const registryPath = tempRegistry();
    registerServer({
      url: "http://localhost:4000",
      repo: ".",
      pr: 1,
      headSha: "old",
      startedAt: "2026-01-01T00:00:00Z",
    }, { registryPath });
    registerServer({
      url: "http://localhost:5000",
      repo: ".",
      pr: 1,
      headSha: "new",
      startedAt: "2026-01-01T00:01:00Z",
    }, { registryPath });

    const found = await findActiveServer({
      registryPath,
      repo: ".",
      pr: 1,
      probe: async (url) => url.endsWith(":5000"),
    });

    expect(found?.url).toBe("http://localhost:5000");
    expect(readRegistry({ registryPath }).entries.map((e) => e.url)).toEqual([
      "http://localhost:5000",
    ]);
  });

  it("findActiveServer prefers the newest live matching entry", async () => {
    const registryPath = tempRegistry();
    registerServer({
      url: "http://localhost:4000",
      repo: ".",
      pr: 1,
      headSha: "old",
      startedAt: "2026-01-01T00:00:00Z",
    }, { registryPath });
    registerServer({
      url: "http://localhost:5000",
      repo: ".",
      pr: 1,
      headSha: "new",
      startedAt: "2026-01-01T00:01:00Z",
    }, { registryPath });

    const found = await findActiveServer({
      registryPath,
      repo: ".",
      pr: 1,
      probe: async () => true,
    });

    expect(found?.url).toBe("http://localhost:5000");
  });
});
