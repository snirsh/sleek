import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTsProvider, maxProjectsFromEnv, touchLru } from "./ts.ts";
import type { LangProvider } from "./types.ts";

/**
 * Fixture project (written to a temp dir):
 *   tsconfig.json                strict, bundler resolution, .ts imports OK
 *   src/a.ts                     export const answer = 42;
 *   src/b.ts                     imports answer, assigns it to a string (error)
 */
describe("createTsProvider", () => {
  let root: string;
  let provider: LangProvider;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sleek-lsp-ts-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          noEmit: true,
        },
      }),
    );
    await writeFile(
      join(root, "src", "a.ts"),
      ["/** The famous constant. */", "export const answer = 42;", ""].join("\n"),
    );
    await writeFile(
      join(root, "src", "b.ts"),
      [
        'import { answer } from "./a.ts";',
        "",
        "const wrong: string = answer;",
        "export const ok = answer + 1;",
        "",
      ].join("\n"),
    );
    provider = createTsProvider(root);
    await provider.ready();
  });

  afterAll(async () => {
    await provider.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("handles ts/js extensions and reports ready", async () => {
    expect(provider.languages).toContain("ts");
    expect(provider.languages).toContain("js");
    expect(await provider.detect()).toBe(true);
    expect(provider.state()).toBe("ready");
  });

  it("hover on a const gives its type as fenced markdown (1-based coords)", async () => {
    // src/a.ts line 2: `export const answer = 42;` — "answer" starts at col 14.
    const hover = await provider.hover("src/a.ts", 2, 14);
    expect(hover).not.toBeNull();
    expect(hover!.contents).toContain("```ts");
    expect(hover!.contents).toContain("const answer: 42");
    expect(hover!.contents).toContain("The famous constant.");
    expect(hover!.range).toMatchObject({ startLine: 2, startCol: 14 });
  });

  it("definition resolves across two files with a preview line", async () => {
    // src/b.ts line 3 col 24: the `answer` reference.
    const defs = await provider.definition("src/b.ts", 3, 24);
    expect(defs.length).toBeGreaterThan(0);
    const def = defs[0];
    expect(def.file).toBe("src/a.ts");
    expect(def.startLine).toBe(2);
    expect(def.preview).toBe("export const answer = 42;");
  });

  it("diagnostics catches the type error, 1-based", async () => {
    const diags = await provider.diagnostics("src/b.ts");
    const err = diags.find((d) => d.severity === "error");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/not assignable to type 'string'/);
    expect(err!.startLine).toBe(3);
    expect(err!.startCol).toBe(7); // `wrong` starts at column 7
    expect(err!.source).toBe("ts");
  });

  it("clean file has no error diagnostics", async () => {
    const diags = await provider.diagnostics("src/a.ts");
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("returns null/[] instead of throwing on out-of-range and missing files", async () => {
    expect(await provider.hover("src/a.ts", 999, 1)).toBeNull();
    expect(await provider.definition("src/nope.ts", 1, 1)).toEqual([]);
    const diags = await provider.diagnostics("src/nope.ts");
    expect(Array.isArray(diags)).toBe(true);
  });

  it('degrades a tsconfig whose lib has no ES entry (e.g. lib:["dom"])', async () => {
    const domOnly = await mkdtemp(join(tmpdir(), "sleek-lsp-dom-"));
    try {
      await writeFile(
        join(domOnly, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, lib: ["dom"], noEmit: true } }),
      );
      await writeFile(
        join(domOnly, "m.ts"),
        "export const r: Record<string, number> = { a: 1 };\n",
      );
      const p = createTsProvider(domOnly);
      const diags = await p.diagnostics("m.ts");
      // Without the guard this file drowns in "Cannot find name 'Record'".
      expect(diags.filter((d) => d.severity === "error")).toEqual([]);
      await p.dispose();
    } finally {
      await rm(domOnly, { recursive: true, force: true });
    }
  });

  it("still reports 2307 for a genuinely broken RELATIVE import in a .ts file", async () => {
    await writeFile(
      join(root, "src", "broken.ts"),
      ['import { nope } from "./missing.ts";', "export const x = nope;", ""].join("\n"),
    );
    const diags = await provider.diagnostics("src/broken.ts");
    const err = diags.find((d) => d.severity === "error");
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/Cannot find module '\.\/missing\.ts'/);
  });

  it("works in single-file mode when no tsconfig exists", async () => {
    const bare = await mkdtemp(join(tmpdir(), "sleek-lsp-bare-"));
    try {
      await writeFile(
        join(bare, "solo.ts"),
        'const n: number = "oops";\nexport const twice = n * 2;\n',
      );
      const p = createTsProvider(bare);
      const diags = await p.diagnostics("solo.ts");
      expect(diags.some((d) => d.severity === "error" && /not assignable/.test(d.message))).toBe(
        true,
      );
      const hover = await p.hover("solo.ts", 2, 14); // `twice`
      expect(hover?.contents).toContain("const twice: number");
      await p.dispose();
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

/**
 * Diagnostics precision for plain JavaScript and analyzer-environment noise.
 *
 * Fixture (temp dir, no node_modules, so @types/node is NOT resolvable):
 *   tsconfig.json     allowJs, NO checkJs, module commonjs (so top-level
 *                     await would normally raise 1378)
 *   script.js         imports 'fs'/'path', uses process.exit, top-level await
 *   checked.js        same shape + `// @ts-check` + a planted real type error
 *   bad.js            a real syntax error
 */
describe("createTsProvider diagnostics precision", () => {
  let root: string;
  let provider: LangProvider;

  const scriptBody = [
    'import { readFileSync } from "fs";',
    'import path from "path";',
    "",
    'const data = readFileSync(path.join(process.cwd(), "x.txt"), "utf8");',
    "await Promise.resolve();",
    "if (!data) process.exit(1);",
    "export {};",
    "",
  ];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sleek-lsp-js-"));
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          allowJs: true,
          target: "ES2020",
          module: "CommonJS",
          noEmit: true,
        },
      }),
    );
    await writeFile(join(root, "script.js"), scriptBody.join("\n"));
    await writeFile(
      join(root, "checked.js"),
      [
        "// @ts-check",
        ...scriptBody,
        'const greeting = "hello";',
        "export const shout = greeting.toUpperCase(5);", // real error: Expected 0 arguments
        "",
      ].join("\n"),
    );
    await writeFile(join(root, "bad.js"), "const x = ;\n");
    provider = createTsProvider(root);
    await provider.ready();
  });

  afterAll(async () => {
    await provider.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("plain .js under a tsconfig without checkJs gets ZERO diagnostics", async () => {
    // Without the gate this file drowns in analyzer-environment noise:
    // 2307 (Cannot find module 'fs'), 2580 (Cannot find name 'process'),
    // 1378 (top-level await under module: commonjs).
    expect(await provider.diagnostics("script.js")).toEqual([]);
  });

  it("// @ts-check opts a .js file in: real errors reported, environment noise still filtered", async () => {
    const diags = await provider.diagnostics("checked.js");
    // The planted misuse is a genuine finding and survives.
    expect(diags.some((d) => /Expected 0 arguments, but got 1/.test(d.message))).toBe(true);
    // The environment-gap family stays filtered even when checking is on.
    for (const d of diags) {
      expect(d.message).not.toMatch(/Cannot find module 'fs'/);
      expect(d.message).not.toMatch(/Cannot find module 'path'/);
      expect(d.message).not.toMatch(/Cannot find name 'process'/);
      expect(d.message).not.toMatch(/Top-level 'await'/);
      expect(d.message).not.toMatch(/type definitions for node/);
    }
  });

  it("a real syntax error in unchecked .js is still reported (syntactic pass)", async () => {
    const diags = await provider.diagnostics("bad.js");
    expect(diags.some((d) => d.severity === "error" && /Expression expected/.test(d.message))).toBe(
      true,
    );
  });

  it("checkJs: true in the tsconfig also opts .js files in", async () => {
    const checked = await mkdtemp(join(tmpdir(), "sleek-lsp-checkjs-"));
    try {
      await writeFile(
        join(checked, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { strict: true, allowJs: true, checkJs: true, noEmit: true },
        }),
      );
      await writeFile(
        join(checked, "m.js"),
        ['const n = 1;', "export const bad = n.toFixed(1, 2);", ""].join("\n"),
      );
      const p = createTsProvider(checked);
      const diags = await p.diagnostics("m.js");
      expect(diags.some((d) => /Expected 0-1 arguments, but got 2/.test(d.message))).toBe(true);
      await p.dispose();
    } finally {
      await rm(checked, { recursive: true, force: true });
    }
  });
});

/**
 * Pure LRU decision logic that bounds live LanguageService Projects
 * (the OOM fix for multi-package monorepo PRs).
 */
describe("touchLru", () => {
  it("inserts a new key at the front (most recently used)", () => {
    expect(touchLru(["a", "b"], "c", 4)).toEqual({
      order: ["c", "a", "b"],
      evicted: [],
    });
  });

  it("touching an existing key moves it to the front without eviction", () => {
    expect(touchLru(["a", "b", "c"], "c", 4)).toEqual({
      order: ["c", "a", "b"],
      evicted: [],
    });
  });

  it("touching the front key is a no-op on order", () => {
    expect(touchLru(["a", "b"], "a", 4)).toEqual({ order: ["a", "b"], evicted: [] });
  });

  it("respects the cap: least-recently-used key is evicted", () => {
    expect(touchLru(["c", "b", "a"], "d", 3)).toEqual({
      order: ["d", "c", "b"],
      evicted: ["a"],
    });
  });

  it("evicts multiple keys oldest-last when the cap shrinks below current size", () => {
    expect(touchLru(["d", "c", "b", "a"], "e", 2)).toEqual({
      order: ["e", "d"],
      evicted: ["c", "b", "a"],
    });
  });

  it("never evicts the touched key: cap is clamped to >= 1", () => {
    expect(touchLru(["a", "b"], "c", 0)).toEqual({
      order: ["c"],
      evicted: ["a", "b"],
    });
  });

  it("a long access sequence keeps at most `max` keys, in MRU order", () => {
    let order: string[] = [];
    const seen: string[][] = [];
    for (const key of ["p1", "p2", "p3", "p1", "p4", "p5", "p2"]) {
      const step = touchLru(order, key, 3);
      order = step.order;
      seen.push(step.evicted);
      expect(order.length).toBeLessThanOrEqual(3);
      expect(order[0]).toBe(key);
    }
    expect(order).toEqual(["p2", "p5", "p4"]);
    // p2 was evicted once (by p5) and later recreated — the recreate path.
    expect(seen.flat()).toEqual(["p2", "p3", "p1"]);
  });
});

describe("maxProjectsFromEnv", () => {
  it("defaults to 4 when unset or invalid", () => {
    expect(maxProjectsFromEnv(undefined)).toBe(4);
    expect(maxProjectsFromEnv("")).toBe(4);
    expect(maxProjectsFromEnv("abc")).toBe(4);
    expect(maxProjectsFromEnv("0")).toBe(4);
    expect(maxProjectsFromEnv("-2")).toBe(4);
    expect(maxProjectsFromEnv("2.5")).toBe(4);
  });

  it("accepts positive integers", () => {
    expect(maxProjectsFromEnv("1")).toBe(1);
    expect(maxProjectsFromEnv("9")).toBe(9);
  });
});

/**
 * End-to-end eviction/recreation: with SLEEK_LSP_MAX_PROJECTS=1, querying a
 * second package's project evicts the first; re-querying the first must
 * transparently recreate it and return IDENTICAL results.
 *
 * Fixture: two sibling packages, each with its own tsconfig.json (→ two
 * Projects), each with a planted type error and a documented const.
 */
describe("createTsProvider project LRU", () => {
  let root: string;

  const pkg = (constDoc: string) => ({
    tsconfig: JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        noEmit: true,
      },
    }),
    main: [
      `/** ${constDoc} */`,
      "export const answer = 42;",
      "const wrong: string = answer;",
      "export const ok = wrong;",
      "",
    ].join("\n"),
  });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "sleek-lsp-lru-"));
    for (const name of ["pkg-a", "pkg-b"]) {
      await mkdir(join(root, name), { recursive: true });
      const { tsconfig, main } = pkg(`Constant of ${name}.`);
      await writeFile(join(root, name, "tsconfig.json"), tsconfig);
      await writeFile(join(root, name, "main.ts"), main);
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("evicts over-cap projects and answers identically after recreation", async () => {
    process.env.SLEEK_LSP_MAX_PROJECTS = "1";
    try {
      const p = createTsProvider(root);

      const diagsBefore = await p.diagnostics("pkg-a/main.ts");
      const hoverBefore = await p.hover("pkg-a/main.ts", 2, 14); // `answer`
      const defsBefore = await p.definition("pkg-a/main.ts", 3, 24); // `answer` ref
      expect(diagsBefore.some((d) => /not assignable to type 'string'/.test(d.message))).toBe(true);
      expect(hoverBefore?.contents).toContain("Constant of pkg-a.");
      expect(p.stats?.()).toEqual({ projects: { count: 1, max: 1 } });

      // Touching pkg-b's project evicts pkg-a's (cap 1) — count stays at 1.
      const diagsB = await p.diagnostics("pkg-b/main.ts");
      expect(diagsB.some((d) => /not assignable to type 'string'/.test(d.message))).toBe(true);
      expect(p.stats?.()).toEqual({ projects: { count: 1, max: 1 } });

      // Re-query pkg-a: its project is recreated and answers are unchanged.
      expect(await p.diagnostics("pkg-a/main.ts")).toEqual(diagsBefore);
      expect(await p.hover("pkg-a/main.ts", 2, 14)).toEqual(hoverBefore);
      expect(await p.definition("pkg-a/main.ts", 3, 24)).toEqual(defsBefore);

      await p.dispose();
      expect(p.stats?.()).toEqual({ projects: { count: 0, max: 1 } });
    } finally {
      delete process.env.SLEEK_LSP_MAX_PROJECTS;
    }
  });

  it("keeps both projects alive under the default cap", async () => {
    const p = createTsProvider(root);
    await p.diagnostics("pkg-a/main.ts");
    await p.diagnostics("pkg-b/main.ts");
    expect(p.stats?.()).toEqual({ projects: { count: 2, max: 4 } });
    await p.dispose();
  });
});
