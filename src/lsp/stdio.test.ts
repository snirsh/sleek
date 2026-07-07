import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFrameParser, encodeFrame, createStdioProvider } from "./stdio.ts";
import type { LangProvider } from "./types.ts";

// --- Pure framing parser ----------------------------------------------------------------

describe("createFrameParser", () => {
  it("parses a single complete frame", () => {
    const seen: unknown[] = [];
    const parser = createFrameParser((m) => seen.push(m));
    parser.push(encodeFrame({ jsonrpc: "2.0", id: 1, result: "ok" }));
    expect(seen).toEqual([{ jsonrpc: "2.0", id: 1, result: "ok" }]);
  });

  it("handles a frame split across many chunks (header and body both split)", () => {
    const seen: unknown[] = [];
    const parser = createFrameParser((m) => seen.push(m));
    const frame = encodeFrame({ method: "x", params: { a: 1 } });
    // Push byte by byte — the cruellest split.
    for (let i = 0; i < frame.length; i++) {
      parser.push(frame.subarray(i, i + 1));
      if (i < frame.length - 1) expect(seen).toEqual([]);
    }
    expect(seen).toEqual([{ method: "x", params: { a: 1 } }]);
  });

  it("handles multiple frames merged into one chunk, in order", () => {
    const seen: unknown[] = [];
    const parser = createFrameParser((m) => seen.push(m));
    parser.push(
      Buffer.concat([
        encodeFrame({ id: 1 }),
        encodeFrame({ id: 2 }),
        encodeFrame({ id: 3 }),
      ]),
    );
    expect(seen).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("handles a merged chunk ending in a partial frame, completed later", () => {
    const seen: unknown[] = [];
    const parser = createFrameParser((m) => seen.push(m));
    const second = encodeFrame({ id: 2, method: "notify" });
    parser.push(Buffer.concat([encodeFrame({ id: 1 }), second.subarray(0, 10)]));
    expect(seen).toEqual([{ id: 1 }]);
    parser.push(second.subarray(10));
    expect(seen).toEqual([{ id: 1 }, { id: 2, method: "notify" }]);
  });

  it("survives multi-byte UTF-8 content (Content-Length is bytes, not chars)", () => {
    const seen: unknown[] = [];
    const parser = createFrameParser((m) => seen.push(m));
    parser.push(encodeFrame({ msg: "héllo — 世界" }));
    expect(seen).toEqual([{ msg: "héllo — 世界" }]);
  });

  it("skips malformed frames without killing the stream", () => {
    const seen: unknown[] = [];
    const parser = createFrameParser((m) => seen.push(m));
    parser.push(Buffer.from("X-Nonsense: yes\r\n\r\n", "ascii")); // no Content-Length
    parser.push(Buffer.from("Content-Length: 3\r\n\r\n{oo", "ascii")); // bad JSON
    parser.push(encodeFrame({ id: 9 }));
    expect(seen).toEqual([{ id: 9 }]);
  });

  it("tolerates extra headers before the body", () => {
    const seen: unknown[] = [];
    const parser = createFrameParser((m) => seen.push(m));
    const body = '{"id":7}';
    parser.push(
      Buffer.from(
        `Content-Type: application/vscode-jsonrpc\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
        "ascii",
      ),
    );
    expect(seen).toEqual([{ id: 7 }]);
  });
});

// --- Client + provider against a scripted fake server -------------------------------------

/**
 * A tiny scripted LSP server (run via `node <script>`): answers initialize,
 * publishes one diagnostic on didOpen, answers hover/definition with canned
 * results, and honours shutdown/exit. Definition points back at the request's
 * own file, line 1, so the provider can read a real preview line.
 */
const FAKE_SERVER = String.raw`
let buf = Buffer.alloc(0);
function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  process.stdout.write("Content-Length: " + body.length + "\r\n\r\n");
  process.stdout.write(body);
}
function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
  } else if (msg.method === "textDocument/didOpen") {
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: msg.params.textDocument.uri,
        diagnostics: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
          severity: 2,
          message: "fake warning",
        }],
      },
    });
  } else if (msg.method === "textDocument/hover") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        contents: { kind: "markdown", value: "**fake hover**" },
        range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } },
      },
    });
  } else if (msg.method === "textDocument/definition") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [{
        uri: msg.params.textDocument.uri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      }],
    });
  } else if (msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "exit") {
    process.exit(0);
  }
}
process.stdin.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const he = buf.indexOf("\r\n\r\n");
    if (he === -1) return;
    const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, he).toString("ascii"));
    const len = Number(m[1]);
    if (buf.length < he + 4 + len) return;
    const msg = JSON.parse(buf.subarray(he + 4, he + 4 + len).toString("utf8"));
    buf = buf.subarray(he + 4 + len);
    handle(msg);
  }
});
`;

describe("createStdioProvider against a scripted fake server", () => {
  let root: string;
  let provider: LangProvider;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sleek-lsp-stdio-"));
    const script = join(root, "fake-server.cjs");
    await writeFile(script, FAKE_SERVER);
    await writeFile(join(root, "main.fake"), "hello fake world\nsecond line\n");
    provider = createStdioProvider({
      command: process.execPath, // `node` — always present, no PATH games
      args: [script],
      languages: ["fake"],
      languageId: "fake",
      worktreeRoot: root,
      installHint: "n/a",
      source: "fake-server",
      requestTimeoutMs: 5000,
      diagnosticsTimeoutMs: 5000,
    });
  });

  afterAll(async () => {
    await provider.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("completes the handshake and reports ready", async () => {
    expect(provider.state()).toBe("off");
    await provider.ready();
    expect(provider.state()).toBe("ready");
  });

  it("hover: didOpen + request, wire 0-based converted to 1-based", async () => {
    const hover = await provider.hover("main.fake", 1, 3);
    expect(hover).not.toBeNull();
    expect(hover!.contents).toBe("**fake hover**");
    expect(hover!.range).toEqual({
      startLine: 5,
      startCol: 3,
      endLine: 5,
      endCol: 9,
    });
  });

  it("definition: maps uri to worktree-relative path with a preview", async () => {
    const defs = await provider.definition("main.fake", 1, 1);
    expect(defs).toEqual([
      {
        file: "main.fake",
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 6,
        preview: "hello fake world",
      },
    ]);
  });

  it("diagnostics: routes the publishDiagnostics notification to the right file", async () => {
    const diags = await provider.diagnostics("main.fake");
    expect(diags).toEqual([
      {
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 5,
        severity: "warning",
        message: "fake warning",
        source: "fake-server", // server sent none → provider's source tag
      },
    ]);
  });

  it("dispose is clean and queries after dispose degrade to null/[]", async () => {
    await provider.dispose();
    expect(provider.state()).toBe("off");
  });
});
