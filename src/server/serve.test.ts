import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileContextReader, isAllowedHost, startServer } from "./serve.ts";
import type { GithubExportOptions, RunningServer, ScaffoldProgressEvent } from "./serve.ts";
import type { LocalRunner } from "../assistant/assistant.ts";
import type { CloudRunner } from "../assistant/escalate.ts";
import type { AssistantMessages } from "../assistant/prompt.ts";
import { makeAnchor, makeLayer, makeScaffold } from "../assistant/fixtures.ts";
import { openStore } from "../store/store.ts";
import type { Store } from "../store/store.ts";
import type { GhRunner } from "../ingest/ingest.ts";
import { parseUnifiedDiff } from "../render/diffmodel.ts";

const HTML = "<!doctype html><h1>review</h1>";

const layer = makeLayer({
  id: "layer-1",
  anchors: [
    makeAnchor({ file: "src/util.ts", side: "RIGHT", startLine: 10, endLine: 20 }),
  ],
});
const scaffold = makeScaffold([layer]);

function fakeLocal(...chunks: string[]): LocalRunner & {
  lastMessages?: AssistantMessages;
  lastModel?: string;
} {
  const runner: LocalRunner & {
    lastMessages?: AssistantMessages;
    lastModel?: string;
  } = {
    async *run(messages, model) {
      runner.lastMessages = messages;
      runner.lastModel = model;
      yield* chunks;
    },
  };
  return runner;
}

function fakeCloud(...chunks: string[]): CloudRunner & {
  lastMessages?: AssistantMessages;
} {
  const runner: CloudRunner & { lastMessages?: AssistantMessages } = {
    async *run(messages) {
      runner.lastMessages = messages;
      yield* chunks;
    },
  };
  return runner;
}

describe("isAllowedHost", () => {
  it("accepts loopback hosts with the bound port", () => {
    expect(isAllowedHost("127.0.0.1:3000", 3000)).toBe(true);
    expect(isAllowedHost("localhost:3000", 3000)).toBe(true);
    expect(isAllowedHost("[::1]:3000", 3000)).toBe(true);
  });

  it("accepts bare loopback hosts without a port", () => {
    expect(isAllowedHost("127.0.0.1", 3000)).toBe(true);
    expect(isAllowedHost("localhost", 3000)).toBe(true);
    expect(isAllowedHost("[::1]", 3000)).toBe(true);
  });

  it("rejects non-loopback hosts, wrong ports, and missing headers", () => {
    expect(isAllowedHost("evil.example.com:3000", 3000)).toBe(false);
    expect(isAllowedHost("127.0.0.1.evil.com:3000", 3000)).toBe(false);
    expect(isAllowedHost("127.0.0.1:9999", 3000)).toBe(false);
    expect(isAllowedHost("[::1]:9999", 3000)).toBe(false);
    expect(isAllowedHost(undefined, 3000)).toBe(false);
    expect(isAllowedHost("", 3000)).toBe(false);
  });
});

describe("startServer", () => {
  let server: RunningServer | undefined;
  let savedKey: string | undefined;
  let savedScaffolderProvider: string | undefined;
  let savedEscalationProvider: string | undefined;

  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    savedScaffolderProvider = process.env.SLEEK_SCAFFOLDER_PROVIDER;
    savedEscalationProvider = process.env.SLEEK_ESCALATION_PROVIDER;
  });

  afterEach(async () => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedScaffolderProvider === undefined) delete process.env.SLEEK_SCAFFOLDER_PROVIDER;
    else process.env.SLEEK_SCAFFOLDER_PROVIDER = savedScaffolderProvider;
    if (savedEscalationProvider === undefined) delete process.env.SLEEK_ESCALATION_PROVIDER;
    else process.env.SLEEK_ESCALATION_PROVIDER = savedEscalationProvider;
    await server?.close();
    server = undefined;
  });

  async function start(overrides: {
    localRunner?: LocalRunner;
    cloudRunner?: CloudRunner;
    contextReader?: (file: string) => string | null;
    store?: Store;
    github?: GithubExportOptions;
    actions?: Parameters<typeof startServer>[0]["actions"];
    scaffolding?: Parameters<typeof startServer>[0]["scaffolding"];
    diffFiles?: Parameters<typeof startServer>[0]["diffFiles"];
    finish?: Parameters<typeof startServer>[0]["finish"];
  } = {}): Promise<string> {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "Add backoff",
      ollamaModel: "fake-model:latest", // explicit → no network at startup
      localRunner: overrides.localRunner ?? fakeLocal("ok"),
      cloudRunner: overrides.cloudRunner ?? fakeCloud("ok"),
      contextReader: overrides.contextReader,
      store: overrides.store,
      github: overrides.github,
      actions: overrides.actions,
      scaffolding: overrides.scaffolding,
      diffFiles: overrides.diffFiles,
      finish: overrides.finish,
    });
    return `http://127.0.0.1:${server.port}`;
  }

  async function closeCurrentServer(): Promise<void> {
    if (!server) return;
    const running = server;
    server = undefined;
    await running.close();
  }

  it("rejects requests with a non-loopback Host header (DNS-rebinding guard)", async () => {
    await start();
    // fetch() refuses to override Host, so drop to node:http for this one.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: server!.port,
          path: "/api/health",
          headers: { host: `evil.example.com:${server!.port}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("serves the provided html at GET /", async () => {
    const base = await start();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(HTML);
  });

  it("reports health with the resolved model and escalation availability", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const base = await start();
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      model: "fake-model:latest",
      escalation: false,
      actions: { blame: false, open: false, permalink: null },
    });
  });

  it("health includes actions availability and a GitHub permalink base", async () => {
    const gh: GhRunner = async () => "{}";
    const base = await start({
      github: { owner: "acme", repo: "rocket", gh, repoPath: "/repo" },
      actions: {
        blame: async () => null,
        openSource: async () => true,
      },
    });
    const body = (await (await fetch(`${base}/api/health`)).json()) as {
      actions: { blame: boolean; open: boolean; permalink: string | null };
    };
    expect(body.actions).toEqual({
      blame: true,
      open: true,
      permalink: "https://github.com/acme/rocket",
    });
  });

  it("reports and runs the optional finish action", async () => {
    let resolveRun!: () => void;
    const ran = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const base = await start({
      finish: {
        available: true,
        async run() {
          resolveRun();
        },
      },
    });

    const health = (await (await fetch(`${base}/api/health`)).json()) as {
      finish: boolean;
    };
    expect(health.finish).toBe(true);

    const res = await fetch(`${base}/api/finish`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await ran;
  });

  it("503s finish when the action is not configured", async () => {
    const base = await start();
    const health = (await (await fetch(`${base}/api/health`)).json()) as {
      finish: boolean;
    };
    expect(health.finish).toBe(false);

    const res = await fetch(`${base}/api/finish`, { method: "POST" });
    expect(res.status).toBe(503);
  });

  it("reports escalation:true when ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const base = await start();
    const health = (await (await fetch(`${base}/api/health`)).json()) as {
      escalation: boolean;
    };
    expect(health.escalation).toBe(true);
  });

  it("reports escalation:true when a CLI Scaffolder provider is configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.SLEEK_ESCALATION_PROVIDER = "codex";
    const base = await start();
    const health = (await (await fetch(`${base}/api/health`)).json()) as {
      escalation: boolean;
    };
    expect(health.escalation).toBe(true);
  });

  it("streams the assistant answer for POST /api/ask (by selection)", async () => {
    const local = fakeLocal("chunk one ", "chunk two");
    const base = await start({ localRunner: local });
    const res = await fetch(`${base}/api/ask`, {
      method: "POST",
      body: JSON.stringify({
        question: "Why backoff?",
        file: "src/util.ts",
        side: "RIGHT",
        startLine: 12,
        endLine: 14,
        selectedText: "const d = base * 2 ** n;",
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("chunk one chunk two");
    // The selection resolved to layer-1: its bundle summary reached the model.
    expect(local.lastMessages?.system).toContain(layer.bundle.summary);
    expect(local.lastMessages?.user).toContain("Why backoff?");
    expect(local.lastModel).toBe("fake-model:latest");
  });

  it("resolves the layer by layerId when given", async () => {
    const local = fakeLocal("ok");
    const base = await start({ localRunner: local });
    const res = await fetch(`${base}/api/ask`, {
      method: "POST",
      body: JSON.stringify({ question: "Q", layerId: "layer-1" }),
    });
    expect(res.status).toBe(200);
    expect(local.lastMessages?.system).toContain(layer.bundle.summary);
  });

  it("answers with layer=null when nothing resolves", async () => {
    const local = fakeLocal("general answer");
    const base = await start({ localRunner: local });
    const res = await fetch(`${base}/api/ask`, {
      method: "POST",
      body: JSON.stringify({ question: "What is this PR?" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("general answer");
    expect(local.lastMessages?.system).toContain("No Layer context");
  });

  it("rejects a body without a question", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/ask`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/question/);
  });

  it("returns 502 JSON when the local runner is unreachable", async () => {
    const local: LocalRunner = {
      async *run() {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      },
    };
    const base = await start({ localRunner: local });
    const res = await fetch(`${base}/api/ask`, {
      method: "POST",
      body: JSON.stringify({ question: "Q" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/ollama serve/i);
  });

  it("returns 501 for /api/escalate without ANTHROPIC_API_KEY", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const base = await start();
    const res = await fetch(`${base}/api/escalate`, {
      method: "POST",
      body: JSON.stringify({ question: "Q" }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Scaffolder escalation is unavailable/);
  });

  it("streams the Opus answer for /api/escalate when a key is present", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const cloud = fakeCloud("opus ", "says hi");
    const base = await start({ cloudRunner: cloud });
    const res = await fetch(`${base}/api/escalate`, {
      method: "POST",
      body: JSON.stringify({ question: "Deep question", layerId: "layer-1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("opus says hi");
    expect(cloud.lastMessages?.system).toContain(layer.bundle.summary);
  });

  it("404s unknown routes with JSON", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
  });

  describe("POST /api/context", () => {
    /** Fake reader: one known file, everything else unreadable. */
    const reader = (file: string): string | null =>
      file === "src/util.ts" ? "alpha\nbeta\ngamma\ndelta\n" : null;

    async function postContext(
      base: string,
      body: unknown,
    ): Promise<Response> {
      return fetch(`${base}/api/context`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    }

    it("returns the requested 1-based inclusive line range", async () => {
      const base = await start({ contextReader: reader });
      const res = await postContext(base, {
        file: "src/util.ts",
        startLine: 2,
        endLine: 3,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        lines: [
          { line: 2, text: "beta" },
          { line: 3, text: "gamma" },
        ],
      });
    });

    it("clamps ranges past EOF and returns [] for fully out-of-range ones", async () => {
      const base = await start({ contextReader: reader });
      const clamped = await postContext(base, {
        file: "src/util.ts",
        startLine: 4,
        endLine: 99,
      });
      expect(await clamped.json()).toEqual({
        lines: [{ line: 4, text: "delta" }],
      });
      const empty = await postContext(base, {
        file: "src/util.ts",
        startLine: 50,
        endLine: 60,
      });
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ lines: [] });
    });

    it("caps a response at 200 lines", async () => {
      const big = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
      const base = await start({ contextReader: () => big.join("\n") });
      const res = await postContext(base, {
        file: "big.ts",
        startLine: 1,
        endLine: 500,
      });
      const body = (await res.json()) as {
        lines: { line: number; text: string }[];
      };
      expect(body.lines).toHaveLength(200);
      expect(body.lines[199]).toEqual({ line: 200, text: "line 200" });
    });

    it("rejects malformed ranges with 400", async () => {
      const base = await start({ contextReader: reader });
      const bodies = [
        { file: "src/util.ts", startLine: "1", endLine: 2 }, // non-numeric
        { file: "src/util.ts", startLine: 0, endLine: 2 }, // below 1
        { file: "src/util.ts", startLine: 5, endLine: 2 }, // inverted
        { file: "src/util.ts", startLine: 1.5, endLine: 2 }, // non-integer
        { startLine: 1, endLine: 2 }, // no file
      ];
      for (const body of bodies) {
        const res = await postContext(base, body);
        expect(res.status).toBe(400);
      }
    });

    it("404s unreadable files with a clear error", async () => {
      const base = await start({ contextReader: reader });
      const res = await postContext(base, {
        file: "src/missing.ts",
        startLine: 1,
        endLine: 5,
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/src\/missing\.ts/);
    });

    it("404s when no contextReader is configured, and health says context:false", async () => {
      const base = await start();
      const res = await postContext(base, {
        file: "src/util.ts",
        startLine: 1,
        endLine: 5,
      });
      expect(res.status).toBe(404);
      const health = (await (await fetch(`${base}/api/health`)).json()) as {
        context: boolean;
      };
      expect(health.context).toBe(false);
    });

    it("reports context:true in health when configured", async () => {
      const base = await start({ contextReader: reader });
      const health = (await (await fetch(`${base}/api/health`)).json()) as {
        context: boolean;
      };
      expect(health.context).toBe(true);
    });
  });

  describe("thread comment visibility routes", () => {
    async function postJson(base: string, path: string, body: unknown): Promise<Response> {
      return fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    async function createThread(base: string, visibility?: "local" | "publishable") {
      const res = await postJson(base, "/api/threads", {
        anchor: { file: "src/util.ts", side: "RIGHT", startLine: 12, endLine: 12 },
        body: "opening comment",
        ...(visibility ? { visibility } : {}),
      });
      expect(res.status).toBe(201);
      return (await res.json()) as {
        id: string;
        comments: { id: string; visibility?: string }[];
      };
    }

    it("accepts optional visibility on POST /api/threads and rejects invalid values", async () => {
      const store = openStore(":memory:");
      const base = await start({ store });

      const local = await createThread(base, "local");
      expect(local.comments[0]!.visibility).toBe("local");

      const omitted = await createThread(base);
      expect(omitted.comments[0]).not.toHaveProperty("visibility");

      const bad = await postJson(base, "/api/threads", {
        anchor: { file: "src/util.ts", side: "RIGHT", startLine: 12, endLine: 12 },
        body: "bad visibility",
        visibility: "private",
      });
      expect(bad.status).toBe(400);
      store.close();
    });

    it("accepts optional visibility on POST /api/threads/:id/comments", async () => {
      const store = openStore(":memory:");
      const base = await start({ store });
      const thread = await createThread(base);

      const reply = await postJson(base, `/api/threads/${thread.id}/comments`, {
        body: "reply",
        visibility: "publishable",
      });
      expect(reply.status).toBe(201);
      expect(((await reply.json()) as { visibility?: string }).visibility).toBe(
        "publishable",
      );

      const bad = await postJson(base, `/api/threads/${thread.id}/comments`, {
        body: "reply",
        visibility: "private",
      });
      expect(bad.status).toBe(400);
      store.close();
    });

    it("updates reviewer comment visibility with 400/404/422/200 responses", async () => {
      const store = openStore(":memory:");
      const base = await start({ store });
      const thread = await createThread(base);
      const commentId = thread.comments[0]!.id;

      const badBody = await postJson(
        base,
        `/api/threads/${thread.id}/comments/${commentId}/visibility`,
        { visibility: "private" },
      );
      expect(badBody.status).toBe(400);

      const missing = await postJson(
        base,
        `/api/threads/${thread.id}/comments/missing/visibility`,
        { visibility: "local" },
      );
      expect(missing.status).toBe(404);

      const assistantComment = store.addComment(
        scaffold.pr.number,
        scaffold.pr.headSha,
        thread.id,
        {
          author: { type: "assistant", model: "fake-model:latest" },
          body: "assistant reply",
          pending: false,
        },
      );
      const nonReviewer = await postJson(
        base,
        `/api/threads/${thread.id}/comments/${assistantComment.id}/visibility`,
        { visibility: "local" },
      );
      expect(nonReviewer.status).toBe(422);
      expect(await nonReviewer.json()).toEqual({
        error: "only reviewer comments",
      });

      const ok = await postJson(
        base,
        `/api/threads/${thread.id}/comments/${commentId}/visibility`,
        { visibility: "local" },
      );
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as {
        ok: boolean;
        comment: { id: string; visibility?: string };
      };
      expect(body).toMatchObject({
        ok: true,
        comment: { id: commentId, visibility: "local" },
      });
      store.close();
    });
  });

  describe("agent routes", () => {
    async function postJson(base: string, path: string, body: unknown): Promise<Response> {
      return fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("GET /api/agent/context includes local threads and published GitHub conversation data", async () => {
      const store = openStore(":memory:");
      const calls: string[] = [];
      const gh: GhRunner = async (args) => {
        calls.push(args[1]!);
        if (String(args[1]).endsWith("/pulls/1/comments")) {
          return JSON.stringify([
            {
              id: 1,
              pull_request_review_id: 9,
              user: { login: "octo" },
              body: "inline",
              created_at: "2026-01-01T00:00:00Z",
              html_url: "https://github.test/inline",
              path: "src/util.ts",
              side: "RIGHT",
              line: 12,
            },
          ]);
        }
        if (String(args[1]).endsWith("/pulls/1/reviews")) {
          return JSON.stringify([
            {
              id: 9,
              user: { login: "reviewer" },
              body: "summary",
              submitted_at: "2026-01-01T00:01:00Z",
              html_url: "https://github.test/review",
              state: "COMMENTED",
            },
          ]);
        }
        return "[]";
      };
      const base = await start({
        store,
        github: { owner: "acme", repo: "rocket", gh, repoPath: "/repo" },
      });

      const created = await postJson(base, "/api/agent/comments", {
        anchor: { file: "src/util.ts", side: "RIGHT", startLine: 12, endLine: 12 },
        body: "local draft",
      });
      expect(created.status).toBe(201);

      const res = await fetch(`${base}/api/agent/context`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        pr: { number: number };
        localThreads: unknown[];
        published: { comments: { source: string; body: string }[]; errors: string[] };
      };
      expect(body.pr.number).toBe(1);
      expect(body.localThreads.length).toBeGreaterThan(0);
      expect(body.published.errors).toEqual([]);
      expect(body.published.comments.map((c) => c.source)).toEqual([
        "github-review-comment",
        "github-review",
      ]);
      expect(calls).toContain("repos/acme/rocket/issues/1/comments");
      store.close();
    });

    it("GET /api/agent/comments refresh=1 bypasses the published GitHub cache", async () => {
      const store = openStore(":memory:");
      let calls = 0;
      const gh: GhRunner = async (args) => {
        if (String(args[1]).endsWith("/pulls/1/comments")) {
          calls++;
          return JSON.stringify([
            {
              id: calls,
              user: { login: "octo" },
              body: `inline ${calls}`,
              created_at: "2026-01-01T00:00:00Z",
              html_url: `https://github.test/inline-${calls}`,
              path: "src/util.ts",
              side: "RIGHT",
              line: 12,
            },
          ]);
        }
        return "[]";
      };
      const base = await start({
        store,
        github: { owner: "acme", repo: "rocket", gh, repoPath: "/repo" },
      });

      const first = (await (await fetch(`${base}/api/agent/comments`)).json()) as {
        published: { comments: { body: string }[] };
      };
      const cached = (await (await fetch(`${base}/api/agent/comments`)).json()) as {
        published: { comments: { body: string }[] };
      };
      const refreshed = (await (await fetch(`${base}/api/agent/comments?refresh=1`)).json()) as {
        published: { comments: { body: string }[] };
      };

      expect(first.published.comments[0]!.body).toBe("inline 1");
      expect(cached.published.comments[0]!.body).toBe("inline 1");
      expect(refreshed.published.comments[0]!.body).toBe("inline 2");
      store.close();
    });

    it("POST /api/agent/comments creates a local-only pending reviewer comment by default", async () => {
      const store = openStore(":memory:");
      const base = await start({ store });

      const res = await postJson(base, "/api/agent/comments", {
        anchor: { file: "src/util.ts", side: "RIGHT", startLine: 12, endLine: 12 },
        body: "agent draft",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        thread: { id: string };
        comment: { author: { type: string }; pending: boolean; visibility: string };
      };
      expect(body.comment).toMatchObject({
        author: { type: "reviewer" },
        pending: true,
        visibility: "local",
      });

      const comments = (await (await fetch(`${base}/api/agent/comments`)).json()) as {
        localDrafts: { comment: { body: string; visibility: string } }[];
      };
      expect(comments.localDrafts.some((d) => d.comment.body === "agent draft" && d.comment.visibility === "local")).toBe(true);
      store.close();
    });

    it("POST /api/agent/comments rejects invalid anchors", async () => {
      const store = openStore(":memory:");
      const base = await start({ store });
      const res = await postJson(base, "/api/agent/comments", {
        anchor: { file: "src/util.ts", side: "RIGHT", startLine: 0, endLine: 1 },
        body: "bad",
      });
      expect(res.status).toBe(400);
      store.close();
    });

    it("POST /api/agent/comments/:id/visibility only changes pending reviewer drafts", async () => {
      const store = openStore(":memory:");
      const base = await start({ store });
      const created = await postJson(base, "/api/agent/comments", {
        anchor: { file: "src/util.ts", side: "RIGHT", startLine: 12, endLine: 12 },
        body: "agent draft",
      });
      const { comment } = (await created.json()) as { comment: { id: string } };

      const ok = await postJson(base, `/api/agent/comments/${comment.id}/visibility`, {
        visibility: "publishable",
      });
      expect(ok.status).toBe(200);
      expect((await ok.json()) as unknown).toMatchObject({
        ok: true,
        comment: { id: comment.id, visibility: "publishable" },
      });

      store.submitReview(scaffold.pr.number, scaffold.pr.headSha, "comment", "");
      const afterSubmit = await postJson(base, `/api/agent/comments/${comment.id}/visibility`, {
        visibility: "local",
      });
      expect(afterSubmit.status).toBe(422);
      store.close();
    });
  });

  describe("code action routes", () => {
    const blame = {
      sha: "abcdef1234567890",
      shortSha: "abcdef123456",
      author: "Ada",
      authorDate: "2026-01-01T00:00:00.000Z",
      summary: "Add utility",
    };

    it("GET /api/blame validates params, handles unwired/null, and returns blame info", async () => {
      const unwired = await start();
      expect((await fetch(`${unwired}/api/blame?file=src/util.ts&side=RIGHT&line=1`)).status).toBe(503);
      await closeCurrentServer();

      const nullBase = await start({ actions: { blame: async () => null } });
      expect((await fetch(`${nullBase}/api/blame?file=src/util.ts&side=RIGHT&line=1`)).status).toBe(404);
      expect((await fetch(`${nullBase}/api/blame?file=src/util.ts&side=BAD&line=1`)).status).toBe(400);
      await closeCurrentServer();

      const seen: unknown[] = [];
      const base = await start({
        actions: {
          blame: async (req) => {
            seen.push(req);
            return blame;
          },
        },
      });
      const res = await fetch(`${base}/api/blame?file=src/util.ts&side=LEFT&line=7`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(blame);
      expect(seen).toEqual([{ file: "src/util.ts", side: "LEFT", line: 7 }]);
    });

    it("POST /api/open validates body, handles unwired/false, and returns ok", async () => {
      const unwired = await start();
      expect(
        (
          await fetch(`${unwired}/api/open`, {
            method: "POST",
            body: JSON.stringify({ file: "src/util.ts", line: 1 }),
          })
        ).status,
      ).toBe(503);
      await closeCurrentServer();

      const falseBase = await start({ actions: { openSource: async () => false } });
      const failed = await fetch(`${falseBase}/api/open`, {
        method: "POST",
        body: JSON.stringify({ file: "src/util.ts", line: 1 }),
      });
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({ ok: false });
      expect(
        (
          await fetch(`${falseBase}/api/open`, {
            method: "POST",
            body: JSON.stringify({ file: "src/util.ts", line: 0 }),
          })
        ).status,
      ).toBe(400);
      await closeCurrentServer();

      const calls: unknown[] = [];
      const base = await start({
        actions: {
          openSource: async (file, line) => {
            calls.push({ file, line });
            return true;
          },
        },
      });
      const ok = await fetch(`${base}/api/open`, {
        method: "POST",
        body: JSON.stringify({ file: "src/util.ts", line: 8 }),
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true });
      expect(calls).toEqual([{ file: "src/util.ts", line: 8 }]);
    });
  });

  describe("POST /api/review/export (Wave 4A)", () => {
    /** Fake gh runner recording every call; resolves `result` or rejects it. */
    function fakeGh(result: string | Error = JSON.stringify({ id: 42 })) {
      const calls: { args: string[]; cwd: string; input?: string }[] = [];
      const gh: GhRunner = async (args, cwd, input) => {
        calls.push({ args, cwd, input });
        if (result instanceof Error) throw result;
        return result;
      };
      return { gh, calls };
    }

    function githubOpts(gh: GhRunner): GithubExportOptions {
      return { owner: "acme", repo: "rocket", gh, repoPath: "/repo" };
    }

    /** Create one reviewer thread and submit the review (the export precondition). */
    async function submitReview(base: string): Promise<void> {
      const created = await fetch(`${base}/api/threads`, {
        method: "POST",
        body: JSON.stringify({
          anchor: { file: "src/util.ts", side: "RIGHT", startLine: 12, endLine: 14 },
          body: "Please extract this into a helper.",
        }),
      });
      expect(created.status).toBe(201);
      const submitted = await fetch(`${base}/api/review/submit`, {
        method: "POST",
        body: JSON.stringify({ verdict: "request_changes", summary: "Needs work." }),
      });
      expect(submitted.status).toBe(200);
    }

    async function postExport(base: string, body?: unknown): Promise<Response> {
      return fetch(`${base}/api/review/export`, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }

    it("404s when no store is configured (threads unavailable)", async () => {
      const base = await start();
      const res = await postExport(base);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /threads unavailable/,
      );
    });

    it("reports githubExport in health: false without a target, true with one", async () => {
      const store = openStore(":memory:");
      const base = await start({ store });
      const health = (await (await fetch(`${base}/api/health`)).json()) as {
        githubExport: boolean;
      };
      expect(health.githubExport).toBe(false);
      await server?.close();
      server = undefined;

      const store2 = openStore(":memory:");
      const base2 = await start({ store: store2, github: githubOpts(fakeGh().gh) });
      const health2 = (await (await fetch(`${base2}/api/health`)).json()) as {
        githubExport: boolean;
      };
      expect(health2.githubExport).toBe(true);
      store.close();
      store2.close();
    });

    it("409s with a clear error when no review has been submitted", async () => {
      const { gh, calls } = fakeGh();
      const store = openStore(":memory:");
      const base = await start({ store, github: githubOpts(gh) });
      const res = await postExport(base);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/submit/i);
      expect(calls).toHaveLength(0);
      store.close();
    });

    it("dryRun returns the payload + preview without calling gh", async () => {
      const { gh, calls } = fakeGh();
      const store = openStore(":memory:");
      const base = await start({ store, github: githubOpts(gh) });
      await submitReview(base);

      const res = await postExport(base, { dryRun: true });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        dryRun: boolean;
        available: boolean;
        payload: {
          event: string;
          body: string;
          comments: Record<string, unknown>[];
        };
        preview: { commentCount: number; files: string[] };
        excludedLocalCount: number;
        reviewExport: unknown;
      };
      expect(body.dryRun).toBe(true);
      expect(body.available).toBe(true);
      expect(body.payload.event).toBe("REQUEST_CHANGES");
      expect(body.payload.body).toBe("Needs work.");
      expect(body.payload.comments).toEqual([
        {
          path: "src/util.ts",
          side: "RIGHT",
          line: 14,
          start_line: 12,
          start_side: "RIGHT",
          body: "Please extract this into a helper.",
        },
      ]);
      expect(body.preview).toMatchObject({
        commentCount: 1,
        files: ["src/util.ts"],
      });
      expect(body.excludedLocalCount).toBe(0);
      expect(body.reviewExport).toBeNull();
      expect(calls).toHaveLength(0);
      store.close();
    });

    it("falls back to an unavailable dry-run when no export target is configured", async () => {
      const store = openStore(":memory:");
      const base = await start({ store });
      await submitReview(base);

      const res = await postExport(base); // NOT a dry-run request
      expect(res.status).toBe(200);
      const body = (await res.json()) as { dryRun: boolean; available: boolean };
      expect(body.dryRun).toBe(true);
      expect(body.available).toBe(false);
      store.close();
    });

    it("posts the review via gh api (payload on stdin), records and reports the export", async () => {
      const { gh, calls } = fakeGh(
        JSON.stringify({
          id: 4242,
          html_url: "https://github.com/acme/rocket/pull/1#pullrequestreview-4242",
        }),
      );
      const store = openStore(":memory:");
      const base = await start({ store, github: githubOpts(gh) });
      await submitReview(base);

      const res = await postExport(base, {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        dryRun: boolean;
        reviewExport: { githubReviewId: number; url: string; exportedAt: string };
      };
      expect(body.dryRun).toBe(false);
      expect(body.reviewExport.githubReviewId).toBe(4242);
      expect(body.reviewExport.url).toContain("pullrequestreview-4242");

      // The gh invocation: raw runner, review-POST args, JSON payload on stdin.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toEqual([
        "api",
        "repos/acme/rocket/pulls/1/reviews",
        "-X",
        "POST",
        "--input",
        "-",
      ]);
      expect(calls[0]!.cwd).toBe("/repo");
      const sent = JSON.parse(calls[0]!.input!) as { event: string };
      expect(sent.event).toBe("REQUEST_CHANGES");

      // The export is persisted and surfaces on GET /api/threads.
      const threads = (await (await fetch(`${base}/api/threads`)).json()) as {
        reviewExport: { githubReviewId: number } | null;
      };
      expect(threads.reviewExport?.githubReviewId).toBe(4242);
      store.close();
    });

    it("409s on a second real export (already posted)", async () => {
      const { gh, calls } = fakeGh();
      const store = openStore(":memory:");
      const base = await start({ store, github: githubOpts(gh) });
      await submitReview(base);

      expect((await postExport(base, {})).status).toBe(200);
      const again = await postExport(base, {});
      expect(again.status).toBe(409);
      const body = (await again.json()) as {
        error: string;
        reviewExport: { githubReviewId: number };
      };
      expect(body.error).toMatch(/already posted/i);
      expect(body.reviewExport.githubReviewId).toBe(42);
      expect(calls).toHaveLength(1); // gh was NOT called a second time
      store.close();
    });

    it("returns a readable 502 when gh rejects (e.g. GitHub 422), recording nothing", async () => {
      const { gh } = fakeGh(
        new Error(
          "`gh api repos/acme/rocket/pulls/1/reviews` failed: " +
            "Pull request review thread line must be part of the diff (HTTP 422)",
        ),
      );
      const store = openStore(":memory:");
      const base = await start({ store, github: githubOpts(gh) });
      await submitReview(base);

      const res = await postExport(base, {});
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/must be part of the diff/);

      // Nothing recorded: a retry is still possible after fixing the anchor.
      const dry = (await (await postExport(base, { dryRun: true })).json()) as {
        reviewExport: unknown;
      };
      expect(dry.reviewExport).toBeNull();
      store.close();
    });

    it("502s when gh returns unparsable output, without recording an export", async () => {
      const { gh } = fakeGh("not json");
      const store = openStore(":memory:");
      const base = await start({ store, github: githubOpts(gh) });
      await submitReview(base);

      const res = await postExport(base, {});
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /unexpected response/i,
      );
      store.close();
    });
  });

  describe("GET /api/versions (Wave 4B)", () => {
    /**
     * A store holding TWO versions of the served PR: an older scaffold at
     * "prevSha" (extra layer + a finding the served one lacks), saved first so
     * its createdAt is older, then the served scaffold itself at "head".
     */
    async function seededStore(): Promise<Store> {
      const store = openStore(":memory:");
      const prevScaffold = {
        ...scaffold,
        pr: { ...scaffold.pr, headSha: "prevSha" },
        layers: [
          {
            ...layer,
            findings: [
              {
                anchor: makeAnchor({ startLine: 12, endLine: 12 }),
                concern: "correctness" as const,
                severity: "major" as const,
                text: "Off-by-one in the retry counter.",
              },
            ],
          },
          makeLayer({
            id: "dropped-layer",
            order: 1,
            anchors: [makeAnchor({ file: "src/dropped.ts" })],
          }),
        ],
      };
      store.saveScaffold(prevScaffold);
      await new Promise((r) => setTimeout(r, 5));
      store.saveScaffold(scaffold);
      return store;
    }

    it("404s both routes when no store is configured, and health says versions:false", async () => {
      const base = await start();
      for (const path of ["/api/versions", "/api/versions/diff?from=x"]) {
        const res = await fetch(`${base}${path}`);
        expect(res.status).toBe(404);
        expect(((await res.json()) as { error: string }).error).toBe(
          "versions unavailable",
        );
      }
      const health = (await (await fetch(`${base}/api/health`)).json()) as {
        versions: boolean;
      };
      expect(health.versions).toBe(false);
    });

    it("reports versions:true in health with a store", async () => {
      const store = openStore(":memory:");
      const base = await start({ store });
      const health = (await (await fetch(`${base}/api/health`)).json()) as {
        versions: boolean;
      };
      expect(health.versions).toBe(true);
      store.close();
    });

    it("lists versions newest-first, marking the served sha current, not stale", async () => {
      const store = await seededStore();
      const base = await start({ store });
      const res = await fetch(`${base}/api/versions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        versions: { headSha: string; createdAt: string; current: boolean }[];
        stale: boolean;
      };
      expect(body.versions.map((v) => [v.headSha, v.current])).toEqual([
        ["head", true],
        ["prevSha", false],
      ]);
      expect(body.stale).toBe(false); // the served sha IS the newest stored one
      store.close();
    });

    it("reports stale when the newest stored version postdates the served one", async () => {
      const store = await seededStore();
      // A third scaffold lands AFTER the served one: the page is now stale.
      await new Promise((r) => setTimeout(r, 5));
      store.saveScaffold({ ...scaffold, pr: { ...scaffold.pr, headSha: "newerSha" } });
      const base = await start({ store });
      const body = (await (await fetch(`${base}/api/versions`)).json()) as {
        versions: { headSha: string; current: boolean }[];
        stale: boolean;
      };
      expect(body.stale).toBe(true);
      expect(body.versions[0]).toMatchObject({ headSha: "newerSha", current: false });
      store.close();
    });

    it("diffs a stored previous version against the served scaffold", async () => {
      const store = await seededStore();
      const base = await start({ store });
      const res = await fetch(`${base}/api/versions/diff?from=prevSha`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        fromSha: string;
        toSha: string;
        diff: {
          counts: Record<string, number>;
          layers: { removed: { id: string }[] };
          findings: { removed: { text: string }[] };
          files: { leaving: string[] };
        };
      };
      expect(body.fromSha).toBe("prevSha");
      expect(body.toSha).toBe("head");
      // prevSha had an extra layer, an extra finding, and touched an extra file.
      expect(body.diff.counts).toMatchObject({
        layersRemoved: 1,
        findingsRemoved: 1,
        filesLeaving: 1,
      });
      expect(body.diff.layers.removed[0]!.id).toBe("dropped-layer");
      expect(body.diff.findings.removed[0]!.text).toBe(
        "Off-by-one in the retry counter.",
      );
      expect(body.diff.files.leaving).toEqual(["src/dropped.ts"]);
      store.close();
    });

    it("400s a diff request without from and 404s an unknown sha, readably", async () => {
      const store = await seededStore();
      const base = await start({ store });

      const missing = await fetch(`${base}/api/versions/diff`);
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as { error: string }).error).toMatch(/from/);

      const unknown = await fetch(`${base}/api/versions/diff?from=nope`);
      expect(unknown.status).toBe(404);
      const body = (await unknown.json()) as { error: string };
      expect(body.error).toMatch(/nope/);
      expect(body.error).toMatch(/PR #1/);
      store.close();
    });

    it("404s unknown /api/versions/ subroutes with JSON", async () => {
      const store = await seededStore();
      const base = await start({ store });
      const res = await fetch(`${base}/api/versions/nope`);
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: string }).toHaveProperty("error");
      store.close();
    });
  });

  describe("saved replies routes (Wave 4C)", () => {
    async function postReply(
      base: string,
      body: unknown,
    ): Promise<Response> {
      return fetch(`${base}/api/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("404s all replies routes when no store is configured, and health says replies:false", async () => {
      const base = await start();
      for (const [method, path] of [
        ["GET", "/api/replies"],
        ["POST", "/api/replies"],
        ["DELETE", "/api/replies/1"],
      ] as const) {
        const res = await fetch(`${base}${path}`, { method });
        expect(res.status).toBe(404);
        expect(((await res.json()) as { error: string }).error).toBe(
          "replies unavailable",
        );
      }
      const health = (await (await fetch(`${base}/api/health`)).json()) as {
        replies: boolean;
      };
      expect(health.replies).toBe(false);
    });

    it("reports replies:true in health with a store", async () => {
      const store = openStore(":memory:");
      const base = await start({ store });
      const health = (await (await fetch(`${base}/api/health`)).json()) as {
        replies: boolean;
      };
      expect(health.replies).toBe(true);
      store.close();
    });

    it("creates, lists and deletes replies", async () => {
      const store = openStore(":memory:");
      const base = await start({ store });

      const created = await postReply(base, { title: "Nit", body: "Nit: rename this." });
      expect(created.status).toBe(201);
      const reply = (await created.json()) as { id: number; title: string; body: string };
      expect(reply).toMatchObject({ title: "Nit", body: "Nit: rename this." });

      await postReply(base, { title: "LGTM", body: "Looks good!" });
      const listed = (await (await fetch(`${base}/api/replies`)).json()) as {
        replies: { id: number; title: string }[];
      };
      expect(listed.replies.map((r) => r.title)).toEqual(["Nit", "LGTM"]);

      const del = await fetch(`${base}/api/replies/${reply.id}`, { method: "DELETE" });
      expect(del.status).toBe(200);
      expect(await del.json()).toEqual({ ok: true });

      const after = (await (await fetch(`${base}/api/replies`)).json()) as {
        replies: { title: string }[];
      };
      expect(after.replies.map((r) => r.title)).toEqual(["LGTM"]);
      store.close();
    });

    it("400s invalid create bodies readably", async () => {
      const store = openStore(":memory:");
      const base = await start({ store });

      const noTitle = await postReply(base, { body: "text" });
      expect(noTitle.status).toBe(400);
      expect(((await noTitle.json()) as { error: string }).error).toMatch(/title/);

      const noBody = await postReply(base, { title: "T", body: "  " });
      expect(noBody.status).toBe(400);
      expect(((await noBody.json()) as { error: string }).error).toMatch(/body/);

      const badJson = await fetch(`${base}/api/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{nope",
      });
      expect(badJson.status).toBe(400);
      store.close();
    });

    it("404s deleting an unknown id and unknown /api/replies/ subroutes", async () => {
      const store = openStore(":memory:");
      const base = await start({ store });

      const unknown = await fetch(`${base}/api/replies/999`, { method: "DELETE" });
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as { error: string }).error).toMatch(/999/);

      const badRoute = await fetch(`${base}/api/replies/nope`, { method: "DELETE" });
      expect(badRoute.status).toBe(404);
      expect((await badRoute.json()) as { error: string }).toHaveProperty("error");
      store.close();
    });
  });

  // ── GET /api/filerows ────────────────────────────────────────────────────────────

  const MINI_DIFF_FILEROWS = `diff --git a/src/foo.ts b/src/foo.ts
index 0000000..1111111 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;

  it("GET /api/filerows returns 404 when diffFiles is not provided", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/filerows?file=src/foo.ts`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/filerows not available/i);
  });

  it("GET /api/filerows returns 400 when file param is missing", async () => {
    const diffFiles = parseUnifiedDiff(MINI_DIFF_FILEROWS);
    const base = await start({ diffFiles });
    const res = await fetch(`${base}/api/filerows`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/file/i);
  });

  it("GET /api/filerows returns 404 for an unknown file", async () => {
    const diffFiles = parseUnifiedDiff(MINI_DIFF_FILEROWS);
    const base = await start({ diffFiles });
    const res = await fetch(`${base}/api/filerows?file=does/not/exist.ts`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown file/i);
  });

  it("GET /api/filerows returns HTML table rows for a known file", async () => {
    const diffFiles = parseUnifiedDiff(MINI_DIFF_FILEROWS);
    const base = await start({ diffFiles });
    const res = await fetch(`${base}/api/filerows?file=src/foo.ts`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<table");
    expect(html).toContain("class=\"row del");
    expect(html).toContain("class=\"row add");
  });

  describe("createFileContextReader", () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "sleek-context-test-"));
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "a.ts"), "one\ntwo\n");
      writeFileSync(join(root, "..", "sleek-context-secret"), "SECRET\n");
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(join(root, "..", "sleek-context-secret"), { force: true });
    });

    it("reads files relative to the root", () => {
      const read = createFileContextReader(root);
      expect(read("src/a.ts")).toBe("one\ntwo\n");
    });

    it("returns null for missing files", () => {
      const read = createFileContextReader(root);
      expect(read("src/nope.ts")).toBeNull();
    });

    it("rejects paths escaping the root (traversal → 404 end to end)", async () => {
      const read = createFileContextReader(root);
      expect(read("../sleek-context-secret")).toBeNull();
      expect(read("src/../../sleek-context-secret")).toBeNull();
      expect(read("/etc/hosts")).toBeNull();

      const base = await start({ contextReader: read });
      const res = await fetch(`${base}/api/context`, {
        method: "POST",
        body: JSON.stringify({
          file: "../sleek-context-secret",
          startLine: 1,
          endLine: 1,
        }),
      });
      expect(res.status).toBe(404);
    });
  });
});


// ── Wave 7: GET /api/models, POST /api/model, POST /api/scaffold ─────────────────────

describe("GET /api/models", () => {
  let server: RunningServer | undefined;
  // Save the real fetch so test client calls bypass the stub
  const clientFetch = globalThis.fetch.bind(globalThis);

  afterEach(async () => {
    vi.unstubAllGlobals();
    await server?.close();
    server = undefined;
  });

  it("returns assistant current model and scaffolder fixed list (Ollama reachable)", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "qwen3:latest",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
    });
    const base = `http://127.0.0.1:${server.port}`;

    // Stub after server starts so the start itself isn't affected
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/api/tags")) {
        return {
          ok: true,
          json: async () => ({
            models: [{ name: "qwen3:latest" }, { name: "qwen2.5-coder:7b" }],
          }),
        } as Response;
      }
      // Pass through real server requests to the test server
      return clientFetch(url as string);
    });

    const res = await clientFetch(`${base}/api/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      assistant: { current: string; models: string[] };
      scaffolder: { available: boolean; anthropic: boolean; replay: boolean; chosen: unknown; models: { id: string; label: string }[] };
    };
    expect(body.assistant.current).toBe("qwen3:latest");
    expect(body.assistant.models).toEqual(["qwen3:latest", "qwen2.5-coder:7b"]);
    expect(body.scaffolder.models.length).toBeGreaterThanOrEqual(3);
    // No ANTHROPIC_API_KEY in test env: Anthropic-API rows are absent (new contract).
    // First group is Claude Code CLI; first 3 ids are the top Claude CLI entries.
    expect(body.scaffolder.models.slice(0, 3).map((m) => m.id)).toEqual([
      "claude:claude-fable-5",
      "claude:claude-opus-4-8",
      "claude:claude-sonnet-4-6",
    ]);
    expect(body.scaffolder.available).toBe(false); // no scaffolding option wired
  });

  it("returns assistant.models:[] when Ollama is unreachable", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "qwen3:latest",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
    });
    const base = `http://127.0.0.1:${server.port}`;

    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/api/tags")) {
        throw new Error("ECONNREFUSED");
      }
      return clientFetch(url as string);
    });

    const res = await clientFetch(`${base}/api/models`);
    const body = (await res.json()) as { assistant: { models: string[] } };
    expect(body.assistant.models).toEqual([]);
  });
});

describe("POST /api/model", () => {
  let server: RunningServer | undefined;
  const clientFetch = globalThis.fetch.bind(globalThis);

  afterEach(async () => {
    vi.unstubAllGlobals();
    await server?.close();
    server = undefined;
  });

  async function startWithTags(tags: string[]) {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "qwen3:latest",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
    });
    // Stub after startServer so boot is unaffected
    const stubFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: tags.map((name) => ({ name })) }),
        } as Response;
      }
      // Pass through to the test server
      return clientFetch(url, init);
    });
    vi.stubGlobal("fetch", stubFetch);
    return `http://127.0.0.1:${server.port}`;
  }

  it("rejects unknown model with 400", async () => {
    const base = await startWithTags(["qwen3:latest"]);
    const res = await clientFetch(`${base}/api/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "unknown:model" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("unknown model");
  });

  it("switches the live model and reflects in health", async () => {
    const base = await startWithTags(["qwen3:latest", "qwen2.5-coder:7b"]);
    const switchRes = await clientFetch(`${base}/api/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen2.5-coder:7b" }),
    });
    expect(switchRes.status).toBe(200);
    const switched = (await switchRes.json()) as { ok: boolean; model: string };
    expect(switched).toEqual({ ok: true, model: "qwen2.5-coder:7b" });

    const healthRes = await clientFetch(`${base}/api/health`);
    const health = (await healthRes.json()) as { model: string };
    expect(health.model).toBe("qwen2.5-coder:7b");
  });

  it("persists the model choice to store when store is present", async () => {
    const store = openStore(":memory:");
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "qwen3:latest",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      store,
    });
    const base = `http://127.0.0.1:${server.port}`;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: [{ name: "qwen3:latest" }] }),
        } as Response;
      }
      return clientFetch(url as string);
    });
    const res = await clientFetch(`${base}/api/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3:latest" }),
    });
    expect(res.status).toBe(200);
    const choices = store.getModelChoices(scaffold.pr.number);
    expect(choices?.assistantModel).toBe("qwen3:latest");
    store.close();
  });
});

describe("POST /api/scaffold", () => {
  let server: RunningServer | undefined;
  const clientFetch = globalThis.fetch.bind(globalThis);

  afterEach(async () => {
    vi.unstubAllGlobals();
    await server?.close();
    server = undefined;
  });

  it("returns 503 when no scaffolding option is wired", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
    });
    const base = `http://127.0.0.1:${server.port}`;
    const res = await clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "replay" }),
    });
    expect(res.status).toBe(503);
  });

  it("returns 409 when a run is already in progress", async () => {
    let firstResolve!: (v: { scaffold: typeof scaffold; html: string }) => void;
    const firstDone = new Promise<{ scaffold: typeof scaffold; html: string }>(
      (r) => { firstResolve = r; },
    );
    let calls = 0;
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: false,
        replay: true,
        run: async (_choice, _onEvent) => {
          calls++;
          return calls === 1 ? firstDone : { scaffold, html: "x" };
        },
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    // Fire first request without awaiting
    const firstProm = clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "replay" }),
    });
    // Give the server a tick to set scaffoldRunning = true
    await new Promise((r) => setTimeout(r, 20));

    const secondRes = await clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "replay" }),
    });
    expect(secondRes.status).toBe(409);
    const body = (await secondRes.json()) as { error: string };
    expect(body.error).toBe("already running");

    // Resolve the first run
    firstResolve({ scaffold, html: HTML });
    await firstProm;
  });

  it("streams NDJSON events and emits done on success", async () => {
    const newScaffold = makeScaffold([
      makeLayer({
        id: "new-layer",
        findings: [
          {
            anchor: makeAnchor(),
            concern: "correctness" as const,
            severity: "minor" as const,
            text: "Finding 1",
          },
          {
            anchor: makeAnchor(),
            concern: "security" as const,
            severity: "major" as const,
            text: "Finding 2",
          },
        ],
      }),
    ]);

    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: true,
        replay: true,
        run: async (_choice, onEvent) => {
          onEvent({ event: "stage", stage: "skeleton", status: "start" });
          onEvent({ event: "stage", stage: "skeleton", status: "done" });
          return { scaffold: newScaffold, html: "<html>new</html>" };
        },
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    const res = await clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "claude:claude-opus-4-8" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const text = await res.text();
    const events = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(events.find((e) => e.event === "stage" && e.stage === "skeleton" && e.status === "start")).toBeTruthy();
    expect(events.find((e) => e.event === "stage" && e.stage === "skeleton" && e.status === "done")).toBeTruthy();
    const doneEvent = events.find((e) => e.event === "done");
    // Wave 9B: every logged event now carries a dense `seq` (frozen protocol).
    expect(doneEvent).toMatchObject({ event: "done", layers: 1, findings: 2 });
    expect(typeof doneEvent.seq).toBe("number");
    // The first logged event is always {event:"job", id, seq:0}.
    expect(events[0]).toMatchObject({ event: "job", seq: 0 });
    expect(typeof events[0].id).toBe("string");
  });

  it("streams error event when run throws", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: true,
        replay: false,
        run: async () => { throw new Error("boom"); },
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    const res = await clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "claude:claude-opus-4-8" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const events = text.trim().split("\n").map((line) => JSON.parse(line));
    const errEvent = events.find((e) => e.event === "error");
    // Wave 9B: logged events carry a dense `seq` (frozen protocol).
    expect(errEvent).toMatchObject({ event: "error", message: "boom" });
    expect(typeof errEvent.seq).toBe("number");
  });

  it("returns 400 for unknown scaffolder choice", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: true,
        replay: true,
        run: async () => ({ scaffold, html: HTML }),
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    const res = await clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "bad-model" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("unaccepted scaffolder choice");
  });

  it("health reports scaffold block with available:false when scaffolding not wired", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
    });
    const base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/api/health`);
    const body = (await res.json()) as { scaffold: { available: boolean; running: boolean } };
    expect(body.scaffold).toMatchObject({ available: false, running: false });
  });

  it("health exposes providerLabel when scaffolding is wired with one", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: true,
        providerLabel: "Claude Code CLI",
        replay: false,
        run: async () => ({ scaffold, html: HTML }),
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/api/health`);
    const body = (await res.json()) as { scaffold: { available: boolean; anthropic: boolean; providerLabel: string } };
    expect(body.scaffold.available).toBe(true);
    expect(body.scaffold.anthropic).toBe(true);
    expect(body.scaffold.providerLabel).toBe("Claude Code CLI");
  });

  it("/api/models exposes providerLabel when scaffolding is wired with one", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: true,
        providerLabel: "Codex CLI",
        replay: false,
        run: async () => ({ scaffold, html: HTML }),
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/api/tags")) {
        return { ok: true, json: async () => ({ models: [] }) } as Response;
      }
      return clientFetch(url as string);
    });
    const res = await clientFetch(`${base}/api/models`);
    const body = (await res.json()) as { scaffolder: { providerLabel: string } };
    expect(body.scaffolder.providerLabel).toBe("Codex CLI");
  });

  it("returns 400 unaccepted scaffolder choice for bare Anthropic model ids", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: false,
        replay: true,
        run: async () => ({ scaffold, html: HTML }),
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const res = await clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "claude-opus-4-8" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unaccepted scaffolder choice: claude-opus-4-8");
  });

  it("passes cli choice with codex provider to the run closure", async () => {
    let capturedChoice: unknown;
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: false,
        replay: false,
        run: async (choice, _onEvent) => {
          capturedChoice = choice;
          return { scaffold, html: HTML };
        },
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const res = await clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "codex" }),
    });
    expect(res.status).toBe(200);
    expect(capturedChoice).toMatchObject({ kind: "cli", provider: "codex" });
  });

  it("passes cli choice with claude provider and model to the run closure", async () => {
    let capturedChoice: unknown;
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: false,
        replay: false,
        run: async (choice, _onEvent) => {
          capturedChoice = choice;
          return { scaffold, html: HTML };
        },
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const res = await clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "claude:claude-opus-4-8" }),
    });
    expect(res.status).toBe(200);
    expect(capturedChoice).toMatchObject({ kind: "cli", provider: "claude", model: "claude-opus-4-8" });
  });

  it("returns 400 for bare unknown provider string (gpt-5.5)", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: true,
        replay: true,
        run: async () => ({ scaffold, html: HTML }),
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const res = await clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "gpt-5.5" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("unaccepted scaffolder choice");
  });

  it("returns 400 for unknown:x provider:model string", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: true,
        replay: true,
        run: async () => ({ scaffold, html: HTML }),
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const res = await clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "unknown:some-model" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("unaccepted scaffolder choice");
  });

  it("GET /api/models includes only claude and codex live provider entries", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: true,
        replay: false,
        run: async () => ({ scaffold, html: HTML }),
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/api/tags")) {
        return { ok: true, json: async () => ({ models: [] }) } as Response;
      }
      return clientFetch(url as string);
    });
    const res = await clientFetch(`${base}/api/models`);
    const body = (await res.json()) as { scaffolder: { models: { id: string; provider: string }[] } };
    const providers = body.scaffolder.models.map((m) => m.provider);
    expect(providers).toContain("claude");
    expect(providers).toContain("codex");
    expect(providers).not.toContain("cursor");
    expect(providers).not.toContain("ollama");
    expect(providers).not.toContain("anthropic");
  });

  // ── Robustness axis B (B1/B2/B3): client disconnect must not crash server ──

  it("B1: client abort mid-stream does not crash the server — health still 200", async () => {
    // We need a deferred scaffold run so the client can abort while streaming.
    let unblock!: () => void;
    const blocked = new Promise<void>((r) => { unblock = r; });

    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: false,
        replay: true,
        run: async (_choice, onEvent) => {
          onEvent({ event: "stage", stage: "ingest", status: "start" });
          // Block until the test unblocks (simulates long-running work).
          await blocked;
          onEvent({ event: "stage", stage: "ingest", status: "done" });
          return { scaffold, html: HTML };
        },
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    // Fire the scaffold request and immediately abort the client.
    const ac = new AbortController();
    const fetchProm = clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "replay" }),
      signal: ac.signal,
    }).catch(() => null); // AbortError is expected

    // Give the server a moment to start writing NDJSON headers.
    await new Promise((r) => setTimeout(r, 30));

    // Abort the client — triggers req close on the server.
    ac.abort();
    await fetchProm;

    // Unblock the scaffold run (it may have already returned, that's fine).
    unblock();

    // Wait a tick for the server to process the close event.
    await new Promise((r) => setTimeout(r, 30));

    // B1 assertion: server is still alive.
    const health = await clientFetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("B2: after an aborted scaffold run, a fresh run succeeds (scaffoldRunning released)", async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((r) => { unblock = r; });
    let runCount = 0;

    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: false,
        replay: true,
        run: async (_choice, onEvent) => {
          runCount++;
          if (runCount === 1) {
            onEvent({ event: "stage", stage: "ingest", status: "start" });
            await blocked;
          }
          return { scaffold, html: HTML };
        },
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    // First request: abort early.
    const ac = new AbortController();
    const firstProm = clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "replay" }),
      signal: ac.signal,
    }).catch(() => null);

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await firstProm;
    unblock();
    // Wait for the finally block to release scaffoldRunning.
    await new Promise((r) => setTimeout(r, 50));

    // B2 assertion: a second request must succeed (not 409).
    const secondRes = await clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "replay" }),
    });
    expect(secondRes.status).toBe(200);
    const text = await secondRes.text();
    const events = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(events.find((e: { event: string }) => e.event === "done")).toBeTruthy();
  });

  it("B3: concurrent scaffold request returns 409 and server stays up", async () => {
    let firstResolve!: (v: { scaffold: typeof scaffold; html: string }) => void;
    const firstDone = new Promise<{ scaffold: typeof scaffold; html: string }>(
      (r) => { firstResolve = r; },
    );

    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: false,
        replay: true,
        run: async (_choice, _onEvent, _opts) => firstDone,
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    // Fire first request without awaiting.
    const firstProm = clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "replay" }),
    });

    // Wait for scaffoldRunning to be true.
    await new Promise((r) => setTimeout(r, 20));

    // B3 assertion: second concurrent request → 409.
    const secondRes = await clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "replay" }),
    });
    expect(secondRes.status).toBe(409);
    const body = (await secondRes.json()) as { error: string };
    expect(body.error).toBe("already running");

    // Health still 200.
    const health = await clientFetch(`${base}/api/health`);
    expect(health.status).toBe(200);

    // Clean up.
    firstResolve({ scaffold, html: HTML });
    await firstProm;
  });
});

// ── Wave 9B: job harness routes (stream / status / cancel) ──────────────────────

describe("scaffold job harness", () => {
  let server: RunningServer | undefined;
  const clientFetch = globalThis.fetch.bind(globalThis);

  afterEach(async () => {
    vi.unstubAllGlobals();
    await server?.close();
    server = undefined;
  });

  it("GET /api/scaffold/status is idle before any job", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: { anthropic: true, replay: true, run: async () => ({ scaffold, html: HTML }) },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const res = await clientFetch(`${base}/api/scaffold/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "idle" });
  });

  it("GET /api/scaffold/stream is 404 before any job", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: { anthropic: true, replay: true, run: async () => ({ scaffold, html: HTML }) },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const res = await clientFetch(`${base}/api/scaffold/stream`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no scaffold job" });
  });

  it("POST /api/scaffold/cancel is 200 ok on an idle server", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: { anthropic: true, replay: true, run: async () => ({ scaffold, html: HTML }) },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const res = await clientFetch(`${base}/api/scaffold/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("first logged event is {event:'job', seq:0}; POST streams from seq 0 to done", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: true,
        replay: true,
        run: async (_c, onEvent) => {
          onEvent({ event: "stage", stage: "ingest", status: "start" });
          onEvent({ event: "stage", stage: "ingest", status: "done" });
          return { scaffold, html: HTML };
        },
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const res = await clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "replay" }),
    });
    const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(events[0]).toMatchObject({ event: "job", seq: 0 });
    // Dense seqs, terminating in done.
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(events[events.length - 1]).toMatchObject({ event: "done" });
  });

  it("409 carries the jobId, and status/stream see the finished job's tail", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: true,
        replay: true,
        run: async (_c, onEvent) => {
          onEvent({ event: "stage", stage: "skeleton", status: "start" });
          await gate;
          return { scaffold, html: HTML };
        },
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    const first = clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "replay" }),
    });
    await new Promise((r) => setTimeout(r, 30));

    const statusRes = await clientFetch(`${base}/api/scaffold/status`);
    const status = (await statusRes.json()) as { state: string; id: string };
    expect(status.state).toBe("running");

    const conflict = await clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "replay" }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "already running", jobId: status.id });

    release();
    await (await first).text();

    // Finished job: stream?since=0 replays the tail through the terminal event.
    const replay = await clientFetch(`${base}/api/scaffold/stream?since=0`);
    expect(replay.status).toBe(200);
    const events = (await replay.text()).trim().split("\n").map((l) => JSON.parse(l));
    // since=0 excludes seq 0 (the job record); tail ends in done.
    expect(events.every((e) => e.seq > 0)).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ event: "done" });

    const finalStatus = await (await clientFetch(`${base}/api/scaffold/status`)).json() as { state: string };
    expect(finalStatus.state).toBe("done");
  });

  it("a client disconnect does NOT abort the job (run completes, state swaps)", async () => {
    let sawAbort = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: true,
        replay: true,
        run: async (_c, onEvent, runOpts) => {
          runOpts?.signal?.addEventListener("abort", () => { sawAbort = true; });
          onEvent({ event: "stage", stage: "skeleton", status: "start" });
          await gate;
          return { scaffold, html: HTML };
        },
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    // Start + immediately abort the client fetch.
    const ac = new AbortController();
    const p = clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "replay" }),
      signal: ac.signal,
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await p;
    await new Promise((r) => setTimeout(r, 30));

    // Job still running — the socket close did not cancel it.
    const running = await (await clientFetch(`${base}/api/scaffold/status`)).json() as { state: string };
    expect(running.state).toBe("running");
    expect(sawAbort).toBe(false);

    release();
    await new Promise((r) => setTimeout(r, 30));
    const done = await (await clientFetch(`${base}/api/scaffold/status`)).json() as { state: string };
    expect(done.state).toBe("done");
  });

  it("cancel aborts the run signal and lands a cancelled terminal event", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      scaffolding: {
        anthropic: true,
        replay: true,
        run: async (_c, onEvent, runOpts) => {
          onEvent({ event: "stage", stage: "skeleton", status: "start" });
          runOpts?.signal?.addEventListener("abort", () => release());
          await gate;
          // Simulate a worker that throws "aborted" after the kill.
          throw new Error("aborted");
        },
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    const streamP = clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "replay" }),
    });
    await new Promise((r) => setTimeout(r, 30));

    const cancelRes = await clientFetch(`${base}/api/scaffold/cancel`, { method: "POST" });
    expect(await cancelRes.json()).toEqual({ ok: true });

    const events = (await (await streamP).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(events[events.length - 1]).toMatchObject({ event: "cancelled" });

    const status = await (await clientFetch(`${base}/api/scaffold/status`)).json() as { state: string };
    expect(status.state).toBe("cancelled");
  });
});

// ── Server hardening tests ────────────────────────────────────────────────────

describe("server hardening: loopback bind", () => {
  let server: RunningServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("server answers on 127.0.0.1 by default (no host option)", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(res.status).toBe(200);
  });

  it("server answers on the explicit host when provided", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      host: "127.0.0.1",
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(res.status).toBe(200);
  });
});

describe("server hardening: readBody 1 MiB cap", () => {
  let server: RunningServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("returns 413 when the request body exceeds 1 MiB", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
    });
    const base = `http://127.0.0.1:${server.port}`;
    const bigBody = "x".repeat(1_048_577); // 1 MiB + 1 byte
    const res = await fetch(`${base}/api/ask`, {
      method: "POST",
      body: bigBody,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/too large/i);
  });

  it("accepts a body right at the limit (1 MiB)", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
    });
    const base = `http://127.0.0.1:${server.port}`;
    // A JSON body at exactly 1 MiB: wrap a padded question string.
    const pad = "q".repeat(1_048_576 - '{"question":"q"}'.length);
    const res = await fetch(`${base}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "q" + pad }),
    });
    // Should not 413 (may 200 or other status depending on content, but not 413)
    expect(res.status).not.toBe(413);
  });
});

describe("server hardening: scaffold store-failure", () => {
  let server: RunningServer | undefined;
  const clientFetch = globalThis.fetch.bind(globalThis);

  afterEach(async () => {
    vi.unstubAllGlobals();
    await server?.close();
    server = undefined;
  });

  it("emits error event and serves old scaffold when store.saveScaffold throws", async () => {
    const newScaffold = makeScaffold([makeLayer({ id: "new-layer" })]);
    const store = openStore(":memory:");

    // Make saveScaffold throw
    const origSave = store.saveScaffold.bind(store);
    vi.spyOn(store, "saveScaffold").mockImplementation(() => {
      throw new Error("disk full");
    });

    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      store,
      scaffolding: {
        anthropic: true,
        replay: true,
        run: async (_choice, _onEvent) => ({ scaffold: newScaffold, html: "<html>new</html>" }),
      },
    });
    const base = `http://127.0.0.1:${server.port}`;

    const res = await clientFetch(`${base}/api/scaffold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scaffolder: "claude:claude-opus-4-8" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const events = text.trim().split("\n").map((line) => JSON.parse(line) as { event: string; message?: string });

    // Must have an error event mentioning persistence failure
    const errEvent = events.find((e) => e.event === "error");
    expect(errEvent).toBeDefined();
    expect(errEvent!.message).toMatch(/persisting it failed/);

    // Must NOT have a done event
    expect(events.find((e) => e.event === "done")).toBeUndefined();

    // GET / must still serve the OLD scaffold HTML
    const page = await clientFetch(`${base}/`);
    expect(await page.text()).toBe(HTML);

    store.close();
    // restore to avoid interference
    vi.restoreAllMocks();
    void origSave;
  });
});

describe("server hardening: export route concurrent guard and pending-comment filter", () => {
  let server: RunningServer | undefined;
  const clientFetch = globalThis.fetch.bind(globalThis);

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function fakeGh(result: string | Error = JSON.stringify({ id: 42 })) {
    const calls: number[] = [];
    const gh: GhRunner = async (_args, _cwd, _input) => {
      calls.push(Date.now());
      if (result instanceof Error) throw result;
      return result;
    };
    return { gh, calls };
  }

  function githubOpts(gh: GhRunner): GithubExportOptions {
    return { owner: "acme", repo: "rocket", gh, repoPath: "/repo" };
  }

  async function setup() {
    const store = openStore(":memory:");
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      store,
      github: githubOpts(fakeGh().gh),
    });
    const base = `http://127.0.0.1:${server.port}`;

    // Create thread + submit review
    await clientFetch(`${base}/api/threads`, {
      method: "POST",
      body: JSON.stringify({
        anchor: { file: "src/util.ts", side: "RIGHT", startLine: 12, endLine: 14 },
        body: "Please extract this.",
      }),
    });
    await clientFetch(`${base}/api/review/submit`, {
      method: "POST",
      body: JSON.stringify({ verdict: "comment", summary: "Done." }),
    });

    return { base, store };
  }

  it("409s a second concurrent non-dry-run export with 'an export is already in progress'", async () => {
    let firstResolve!: (v: string) => void;
    const firstDone = new Promise<string>((r) => { firstResolve = r; });
    let callCount = 0;
    const slowGh: GhRunner = async () => {
      callCount++;
      return callCount === 1 ? firstDone : JSON.stringify({ id: 42 });
    };
    const store = openStore(":memory:");
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      store,
      github: { owner: "acme", repo: "rocket", gh: slowGh, repoPath: "/repo" },
    });
    const base = `http://127.0.0.1:${server.port}`;

    // Submit review first
    await clientFetch(`${base}/api/threads`, {
      method: "POST",
      body: JSON.stringify({
        anchor: { file: "src/util.ts", side: "RIGHT", startLine: 1, endLine: 1 },
        body: "comment",
      }),
    });
    await clientFetch(`${base}/api/review/submit`, {
      method: "POST",
      body: JSON.stringify({ verdict: "comment", summary: "" }),
    });

    // Fire first export without awaiting
    const first = clientFetch(`${base}/api/review/export`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    // Give server a tick
    await new Promise((r) => setTimeout(r, 20));

    // Second concurrent export should 409
    const second = await clientFetch(`${base}/api/review/export`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("an export is already in progress");

    // Resolve first
    firstResolve(JSON.stringify({ id: 99 }));
    await first;
    store.close();
  });

  it("dry-run export includes excludedPendingCount in the response", async () => {
    const { base, store } = await setup();
    // The thread comment is pending (submitted via POST /api/threads, pending:true)
    // After submitReview it becomes non-pending — use the store to check.
    const res = await clientFetch(`${base}/api/review/export`, {
      method: "POST",
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { excludedPendingCount: number; excludedLocalCount: number };
    expect(typeof body.excludedPendingCount).toBe("number");
    expect(typeof body.excludedLocalCount).toBe("number");
    store.close();
  });
});

describe("server hardening: createFileContextReader symlink rejection", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sleek-symlink-test-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "safe.ts"), "safe content\n");
    // Create a secret file outside the root
    writeFileSync(join(root, "..", "secret-" + Date.now()), "SECRET\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a symlink pointing outside the root (symlink traversal)", () => {
    const secretPath = join(root, "..", "secret-" + Date.now());
    writeFileSync(secretPath, "SECRET\n");
    // Create symlink inside root pointing outside
    const linkPath = join(root, "src", "evil.ts");
    try {
      symlinkSync(secretPath, linkPath);
    } catch {
      // If symlink creation fails (unlikely on macOS), skip
      return;
    }
    const reader = createFileContextReader(root);
    expect(reader("src/evil.ts")).toBeNull();
    rmSync(secretPath, { force: true });
  });

  it("still reads a legitimate file after the symlink check", () => {
    const reader = createFileContextReader(root);
    expect(reader("src/safe.ts")).toBe("safe content\n");
  });
});

describe("server hardening: LSP route path validation", () => {
  let server: RunningServer | undefined;
  const clientFetch = globalThis.fetch.bind(globalThis);

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function fakeLspManager() {
    return {
      status: async () => ({ providers: [] }),
      availability: async (_file: string) => ({ available: true as const }),
      hover: async () => null,
      definition: async () => [],
      diagnostics: async () => [],
      providerFor: () => null,
      dispose: async () => {},
    };
  }

  it("400s on absolute file paths in LSP routes", async () => {
    server = await startServer({
      html: HTML,
      scaffold,
      prTitle: "t",
      ollamaModel: "fake:model",
      localRunner: fakeLocal("ok"),
      cloudRunner: fakeCloud("ok"),
      lsp: fakeLspManager() as unknown as Parameters<typeof startServer>[0]["lsp"],
      lspWorktree: "/some/worktree",
    });
    const base = `http://127.0.0.1:${server.port}`;

    const res = await clientFetch(`${base}/api/lsp/hover`, {
      method: "POST",
      body: JSON.stringify({ file: "/etc/passwd", line: 1, character: 1 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/absolute/i);
  });

  it("400s on traversal paths that escape the worktree in LSP routes", async () => {
    const wt = mkdtempSync(join(tmpdir(), "sleek-lsp-wt-"));
    try {
      server = await startServer({
        html: HTML,
        scaffold,
        prTitle: "t",
        ollamaModel: "fake:model",
        localRunner: fakeLocal("ok"),
        cloudRunner: fakeCloud("ok"),
        lsp: fakeLspManager() as unknown as Parameters<typeof startServer>[0]["lsp"],
        lspWorktree: wt,
      });
      const base = `http://127.0.0.1:${server.port}`;

      const res = await clientFetch(`${base}/api/lsp/diagnostics`, {
        method: "POST",
        body: JSON.stringify({ file: "../../etc/passwd" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/escapes/i);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
