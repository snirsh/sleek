import { afterEach, describe, expect, it } from "vitest";

import { startServer } from "../server/serve.ts";
import type { RunningServer } from "../server/serve.ts";
import { makeLayer, makeScaffold } from "../assistant/fixtures.ts";
import type { LspManager } from "./manager.ts";
import type { LangStatus } from "./types.ts";

/**
 * The /api/lsp/* server routes, exercised with a fake LspManager injected —
 * no real providers, no worktree.
 */

const STATUS: Record<string, LangStatus> = {
  ts: { available: true, state: "ready" },
  rust: {
    available: false,
    state: "unavailable",
    installHint: "brew install rust-analyzer",
  },
};

function fakeManager(): LspManager & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    providerFor: () => null,
    async availability(file: string) {
      if (file.endsWith(".rs")) {
        return { available: false, installHint: "brew install rust-analyzer" };
      }
      if (file.endsWith(".css")) return { available: false };
      return { available: true };
    },
    async hover(file: string, line: number, character: number) {
      calls.push(["hover", file, line, character]);
      return { contents: "```ts\nconst x: number\n```" };
    },
    async definition(file: string, line: number, character: number) {
      calls.push(["definition", file, line, character]);
      return [
        {
          file: "src/a.ts",
          startLine: 2,
          startCol: 14,
          endLine: 2,
          endCol: 20,
          preview: "export const answer = 42;",
        },
      ];
    },
    async diagnostics(file: string) {
      calls.push(["diagnostics", file]);
      return [
        {
          startLine: 3,
          startCol: 7,
          endLine: 3,
          endCol: 12,
          severity: "error" as const,
          message: "boom",
          source: "ts",
        },
      ];
    },
    async status() {
      return STATUS;
    },
    async dispose() {},
  };
}

describe("LSP server routes", () => {
  let server: RunningServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(lsp?: LspManager): Promise<string> {
    server = await startServer({
      html: "<!doctype html><h1>r</h1>",
      scaffold: makeScaffold([makeLayer()]),
      prTitle: "T",
      ollamaModel: "fake-model:latest", // explicit → no network at startup
      lsp,
    });
    return `http://127.0.0.1:${server.port}`;
  }

  it("404s every /api/lsp route when no manager is wired in", async () => {
    const base = await start();
    for (const [method, path] of [
      ["GET", "/api/lsp/status"],
      ["POST", "/api/lsp/hover"],
      ["POST", "/api/lsp/definition"],
      ["POST", "/api/lsp/diagnostics"],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method,
        body: method === "POST" ? JSON.stringify({ file: "a.ts" }) : undefined,
      });
      expect(res.status).toBe(404);
    }
  });

  it("health omits the lsp key without a manager, includes it with one", async () => {
    let base = await start();
    let health = (await (await fetch(`${base}/api/health`)).json()) as Record<
      string,
      unknown
    >;
    expect("lsp" in health).toBe(false);
    await server!.close();
    server = undefined;

    base = await start(fakeManager());
    health = (await (await fetch(`${base}/api/health`)).json()) as Record<
      string,
      unknown
    >;
    expect(health.lsp).toEqual(STATUS);
  });

  it("GET /api/lsp/status returns the manager's status", async () => {
    const base = await start(fakeManager());
    const res = await fetch(`${base}/api/lsp/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STATUS);
  });

  it("POST /api/lsp/hover forwards 1-based coordinates and wraps the result", async () => {
    const manager = fakeManager();
    const base = await start(manager);
    const res = await fetch(`${base}/api/lsp/hover`, {
      method: "POST",
      body: JSON.stringify({ file: "src/b.ts", line: 3, character: 24 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      available: true,
      hover: { contents: "```ts\nconst x: number\n```" },
    });
    expect(manager.calls).toEqual([["hover", "src/b.ts", 3, 24]]);
  });

  it("POST /api/lsp/definition returns the definition list", async () => {
    const base = await start(fakeManager());
    const res = await fetch(`${base}/api/lsp/definition`, {
      method: "POST",
      body: JSON.stringify({ file: "src/b.ts", line: 3, character: 24 }),
    });
    const body = (await res.json()) as { available: boolean; definitions: unknown[] };
    expect(body.available).toBe(true);
    expect(body.definitions).toHaveLength(1);
  });

  it("POST /api/lsp/diagnostics returns the diagnostics list", async () => {
    const base = await start(fakeManager());
    const res = await fetch(`${base}/api/lsp/diagnostics`, {
      method: "POST",
      body: JSON.stringify({ file: "src/b.ts" }),
    });
    expect(await res.json()).toEqual({
      available: true,
      diagnostics: [
        {
          startLine: 3,
          startCol: 7,
          endLine: 3,
          endCol: 12,
          severity: "error",
          message: "boom",
          source: "ts",
        },
      ],
    });
  });

  it("answers 200 {available:false, installHint} for an unavailable language", async () => {
    const base = await start(fakeManager());
    const res = await fetch(`${base}/api/lsp/hover`, {
      method: "POST",
      body: JSON.stringify({ file: "lib.rs", line: 1, character: 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      available: false,
      installHint: "brew install rust-analyzer",
    });
  });

  it("omits installHint when there simply is no provider for the extension", async () => {
    const base = await start(fakeManager());
    const res = await fetch(`${base}/api/lsp/diagnostics`, {
      method: "POST",
      body: JSON.stringify({ file: "style.css" }),
    });
    expect(await res.json()).toEqual({ available: false });
  });

  it("400s bad bodies: invalid JSON, missing file, missing position", async () => {
    const base = await start(fakeManager());

    let res = await fetch(`${base}/api/lsp/hover`, {
      method: "POST",
      body: "{nope",
    });
    expect(res.status).toBe(400);

    res = await fetch(`${base}/api/lsp/hover`, {
      method: "POST",
      body: JSON.stringify({ line: 1, character: 1 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/file/);

    res = await fetch(`${base}/api/lsp/definition`, {
      method: "POST",
      body: JSON.stringify({ file: "a.ts" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/line/);

    // diagnostics needs only `file`
    res = await fetch(`${base}/api/lsp/diagnostics`, {
      method: "POST",
      body: JSON.stringify({ file: "a.ts" }),
    });
    expect(res.status).toBe(200);
  });
});
