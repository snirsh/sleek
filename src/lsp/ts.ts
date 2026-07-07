/**
 * TypeScript/JavaScript LangProvider backed by the `typescript` package's
 * LanguageService — no external binary and no LSP wire protocol.
 *
 * `typescript` is a devDependency imported at runtime here; acceptable for a
 * local-only tool (Sleek always runs from its own checkout with dev deps
 * installed), and it keeps the provider free of process management.
 *
 * Project discovery: for each queried file we walk UP from the file's
 * directory to the worktree root looking for the nearest tsconfig.json. If
 * found, we take its compilerOptions ONLY (extends resolved, but the file
 * set is never enumerated — monorepo-scale configs would be prohibitive)
 * and create a LanguageService whose root files are just the files Sleek has
 * asked about; TypeScript then pulls transitive imports lazily via a
 * disk-backed LanguageServiceHost. node_modules resolve from the worktree
 * when installed/symlinked; unresolved imports degrade to diagnostics, never
 * crashes. Without a tsconfig we fall back to single-file mode with lenient
 * options (allowJs, esModuleInterop, node resolution).
 *
 * Diagnostics precision: squiggles in a review UI must be findings about the
 * PR, so plain JS files get semantic diagnostics only when they opt in
 * (checkJs / `// @ts-check`), and analyzer-environment noise is filtered via
 * ENVIRONMENT_DIAG_CODES.
 *
 * Memory bounds (a 13-file PR across 9 monorepo packages once OOM'd a 4GB
 * heap): one DocumentRegistry is shared by every LanguageService so lib/.d.ts
 * SourceFiles aren't duplicated per project; live Projects are LRU-capped
 * (SLEEK_LSP_MAX_PROJECTS, default 4) with evicted services disposed and
 * recreated on the next query; checker state is released after every query
 * via cleanupSemanticCache(); and the module graph is bounded where safe
 * (maxNodeModuleJsDepth: 0, disableSourceOfProjectReferenceRedirect).
 *
 * Coordinates: 1-based in/out (see types.ts); the compiler API is 0-based.
 */

import { readFileSync, existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import ts from "typescript";

import type {
  Diag,
  DefResult,
  HoverResult,
  LangProvider,
  ProviderState,
} from "./types.ts";

const TS_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];

/** JS-family files: semantic diagnostics only when the file opts into checking. */
const JS_FILE = /\.(?:js|jsx|mjs|cjs)$/i;

/**
 * Diagnostic codes that describe SLEEK'S ANALYSIS ENVIRONMENT — a missing
 * @types package, a tsconfig module/resolution mismatch — rather than the code
 * under review. In a review UI a squiggle is a claim that the PR has a
 * problem, so analyzer-environment complaints are never review findings and
 * are dropped for both TS and JS files:
 *
 * - 1375 / 1378  Top-level 'await' only allowed when module is es2022+/system
 *                (and target es2017+). A module-kind mismatch between our
 *                resolved compilerOptions and how the file actually runs.
 * - 2580         Cannot find name 'require'/'process'/'Buffer'/'module' —
 *                "install @types/node". The types package is absent from the
 *                worktree, not a bug in the PR.
 * - 2591         Same as 2580, variant that also suggests changing `lib`.
 * - 2792         Cannot find module — "did you mean to set moduleResolution
 *                to 'nodenext'?" A tsconfig suggestion, not a code problem.
 * - 7016         Could not find a declaration file for module 'X' (implicit
 *                any from a missing .d.ts of an external dependency).
 *
 * 2307 (Cannot find module) is handled separately in
 * `isEnvironmentDiagnostic`: dropped only for Node builtins (fs, path,
 * node:*, …), where it means "@types/node is missing"; a broken RELATIVE
 * import is a genuine finding and stays.
 */
const ENVIRONMENT_DIAG_CODES = new Set<number>([1375, 1378, 2580, 2591, 2792, 7016]);

/** TS2307 — environment noise only when the unresolved module is a Node builtin. */
const CANNOT_FIND_MODULE = 2307;

/**
 * Is `spec` a Node builtin ('fs', 'path', 'fs/promises', 'node:test', …)?
 * TypeScript doesn't expose its core-modules list publicly, so we use the
 * running Node's own `builtinModules` plus the node: prefix rule.
 */
function isNodeBuiltin(spec: string): boolean {
  return spec.startsWith("node:") || builtinModules.includes(spec);
}

/** Environment-gap diagnostic (see ENVIRONMENT_DIAG_CODES) — not a review finding. */
function isEnvironmentDiagnostic(d: ts.Diagnostic): boolean {
  if (ENVIRONMENT_DIAG_CODES.has(d.code)) return true;
  if (d.code === CANNOT_FIND_MODULE) {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    const spec = /^Cannot find module '([^']+)'/.exec(message)?.[1];
    return spec !== undefined && isNodeBuiltin(spec);
  }
  return false;
}

/**
 * Does the file opt into checking via a leading `// @ts-check` pragma?
 * Mirrors TypeScript: only single-line comments in the file's leading trivia
 * count, and `// @ts-nocheck` wins over a later `// @ts-check`.
 */
function hasTsCheckPragma(text: string): boolean {
  // Leading trivia starts after a shebang, if any.
  const pos = text.startsWith("#!") ? text.indexOf("\n") + 1 || text.length : 0;
  for (const range of ts.getLeadingCommentRanges(text, pos) ?? []) {
    if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
    const comment = text.slice(range.pos, range.end);
    if (/^\/\/\/?\s*@ts-nocheck\b/.test(comment)) return false;
    if (/^\/\/\/?\s*@ts-check\b/.test(comment)) return true;
  }
  return false;
}

/** Lenient options for files with no tsconfig above them. */
const SINGLE_FILE_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  esModuleInterop: true,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
  // Never type-mine JS inside node_modules — huge graphs for zero review value.
  maxNodeModuleJsDepth: 0,
  disableSourceOfProjectReferenceRedirect: true,
};

// --- Project LRU (pure decision logic, exported for tests) ------------------------------

/** Default cap on live Projects (LanguageServices). Override: SLEEK_LSP_MAX_PROJECTS. */
const DEFAULT_MAX_PROJECTS = 4;

/** Parse SLEEK_LSP_MAX_PROJECTS: a positive integer, else the default. */
export function maxProjectsFromEnv(
  raw: string | undefined = process.env.SLEEK_LSP_MAX_PROJECTS,
): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_PROJECTS;
}

/**
 * Pure LRU step: given project keys in most-recently-used-FIRST order, the
 * key just touched (possibly new), and the cap, return the new MRU order and
 * the keys that fell off the end and must be evicted. Cap is clamped to >= 1
 * so the project being touched always survives its own query.
 */
export function touchLru(
  order: readonly string[],
  key: string,
  max: number,
): { order: string[]; evicted: string[] } {
  const cap = Math.max(1, Math.floor(max));
  const next = [key, ...order.filter((k) => k !== key)];
  return { order: next.slice(0, cap), evicted: next.slice(cap) };
}

interface Project {
  service: ts.LanguageService;
  /** Effective compilerOptions (resolved tsconfig or the single-file fallback). */
  options: ts.CompilerOptions;
  /** Files explicitly opened (queried) — the service's root files. */
  rootFiles: Set<string>;
  snapshots: Map<string, ts.IScriptSnapshot | null>;
}

/** Walk up from `file`'s directory to `root` looking for tsconfig.json. */
function findTsconfig(file: string, root: string): string | null {
  let dir = dirname(resolve(file));
  const stop = resolve(root);
  // Guard against files outside the worktree: cap the walk.
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    if (dir === stop || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return null;
}

interface TsconfigInfo {
  options: ts.CompilerOptions;
  /**
   * The config chain's LITERAL `files` entries (capped) — typically ambient
   * declaration files like external-types.d.ts. `include` globs are never
   * expanded (readDirectory is stubbed), so huge filesets stay cheap.
   */
  seedFiles: string[];
}

/** Cap on how many literal `files` entries we seed as extra roots. */
const MAX_SEED_FILES = 64;

/**
 * Read a tsconfig's compilerOptions with `extends` resolved, WITHOUT
 * enumerating its glob file set (readDirectory is stubbed to []).
 */
function readCompilerOptions(tsconfigPath: string): TsconfigInfo {
  try {
    const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (!read.config) return { options: { ...SINGLE_FILE_OPTIONS }, seedFiles: [] };
    const host: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: () => [],
    };
    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      host,
      dirname(tsconfigPath),
    );
    // Degrade guard: a `lib` with no ES entry (e.g. a package's
    // `"lib": ["dom"]`) would lose Record/Promise/every built-in and drown
    // real diagnostics in noise. Drop it so the target's default (full) lib
    // applies — which includes dom anyway.
    if (parsed.options.lib && !parsed.options.lib.some((l) => /^lib\.es/.test(l))) {
      delete parsed.options.lib;
    }
    return {
      options: {
        ...parsed.options,
        // We only query; never emit, never build project references.
        noEmit: true,
        composite: false,
        incremental: false,
        skipLibCheck: true,
        // Bound the module graph: don't type-mine JS inside node_modules, and
        // don't chase project-reference sources instead of their .d.ts output
        // (unless the config explicitly opted in).
        maxNodeModuleJsDepth: 0,
        disableSourceOfProjectReferenceRedirect:
          parsed.options.disableSourceOfProjectReferenceRedirect ?? true,
      },
      // With readDirectory stubbed, fileNames holds only literal `files`
      // entries (e.g. global .d.ts ambients) — seed them so declarations
      // like a bundler's __non_webpack_require__ ambient are visible.
      seedFiles: parsed.fileNames
        .filter((f) => ts.sys.fileExists(f))
        .slice(0, MAX_SEED_FILES),
    };
  } catch {
    return { options: { ...SINGLE_FILE_OPTIONS }, seedFiles: [] };
  }
}

function severityOf(category: ts.DiagnosticCategory): Diag["severity"] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "hint";
    default:
      return "info";
  }
}

/** Create the ts/js provider rooted at a worktree checkout. */
export function createTsProvider(worktreeRoot: string): LangProvider {
  const root = resolve(worktreeRoot);
  /** Keyed by tsconfig path, or "" for the single-file fallback project. */
  const projects = new Map<string, Project>();
  /** Project keys, most-recently-used first (see touchLru). */
  let mruOrder: string[] = [];
  const maxProjects = maxProjectsFromEnv();
  // ONE registry for all LanguageServices: SourceFiles of lib.d.ts and shared
  // dependencies are reference-counted and shared across projects instead of
  // being re-parsed and duplicated per service.
  const registry = ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, root);
  let state: ProviderState = "off";

  function makeProject(options: ts.CompilerOptions): Project {
    const rootFiles = new Set<string>();
    const snapshots = new Map<string, ts.IScriptSnapshot | null>();

    const readSnapshot = (fileName: string): ts.IScriptSnapshot | null => {
      const cached = snapshots.get(fileName);
      if (cached !== undefined) return cached;
      let snap: ts.IScriptSnapshot | null = null;
      try {
        const text = readFileSync(fileName, "utf8");
        snap = ts.ScriptSnapshot.fromString(text);
      } catch {
        snap = null;
      }
      snapshots.set(fileName, snap);
      return snap;
    };

    // The worktree is an immutable detached checkout, so script versions are
    // constant and snapshots cache forever.
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [...rootFiles],
      getScriptVersion: () => "1",
      getScriptSnapshot: (f) => readSnapshot(f) ?? undefined,
      getCurrentDirectory: () => root,
      getCompilationSettings: () => options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };

    return {
      service: ts.createLanguageService(host, registry),
      options,
      rootFiles,
      snapshots,
    };
  }

  /** Dispose a project's service (releases registry refs) and drop its caches. */
  function disposeProject(project: Project): void {
    try {
      project.service.dispose();
    } catch {
      /* ignore */
    }
    project.snapshots.clear();
    project.rootFiles.clear();
  }

  /**
   * Release the queried project's type-checker state. Cheap; TS rebuilds it
   * lazily on the next query, and parsed SourceFiles stay cached in the
   * registry/snapshots, so only the heavy checker allocations are freed.
   */
  function trimCaches(project: Project): void {
    try {
      project.service.cleanupSemanticCache();
    } catch {
      /* ignore */
    }
  }

  /**
   * Get/create the project for `file` and register it as a root file.
   * Every call is an LRU touch; projects over the cap are disposed (their
   * module graph and checker state become collectible) and transparently
   * recreated on a later query — slower first answer, never an OOM.
   */
  function projectFor(absFile: string): Project {
    const tsconfig = findTsconfig(absFile, root);
    const key = tsconfig ?? "";
    let project = projects.get(key);
    if (!project) {
      const info: TsconfigInfo = tsconfig
        ? readCompilerOptions(tsconfig)
        : { options: { ...SINGLE_FILE_OPTIONS }, seedFiles: [] };
      project = makeProject(info.options);
      for (const seed of info.seedFiles) project.rootFiles.add(resolve(seed));
      projects.set(key, project);
    }
    const { order, evicted } = touchLru(mruOrder, key, maxProjects);
    mruOrder = order;
    for (const evictedKey of evicted) {
      const evictee = projects.get(evictedKey);
      projects.delete(evictedKey);
      if (evictee) disposeProject(evictee);
    }
    if (!project.rootFiles.has(absFile)) project.rootFiles.add(absFile);
    return project;
  }

  function absPath(file: string): string {
    return isAbsolute(file) ? resolve(file) : resolve(root, file);
  }

  /** 1-based line/col → 0-based offset in `file`, or null when out of range. */
  function offsetOf(
    project: Project,
    absFile: string,
    line: number,
    character: number,
  ): number | null {
    const program = project.service.getProgram();
    const sf = program?.getSourceFile(absFile);
    if (!sf) return null;
    try {
      return ts.getPositionOfLineAndCharacter(sf, line - 1, character - 1);
    } catch {
      return null;
    }
  }

  /** 0-based span in `fileName` → 1-based LspRange (via that file's text). */
  function rangeOf(
    text: string,
    span: ts.TextSpan,
  ): { startLine: number; startCol: number; endLine: number; endCol: number } {
    const at = (offset: number) => {
      // Cheap line/col from raw text (avoids needing a SourceFile per target).
      let line = 1;
      let lineStart = 0;
      for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === "\n") {
          line++;
          lineStart = i + 1;
        }
      }
      return { line, col: offset - lineStart + 1 };
    };
    const start = at(span.start);
    const end = at(span.start + span.length);
    return {
      startLine: start.line,
      startCol: start.col,
      endLine: end.line,
      endCol: end.col,
    };
  }

  function toRelative(absFile: string): string {
    const rel = relative(root, absFile);
    return rel.startsWith("..") || isAbsolute(rel) ? absFile : rel.split(sep).join("/");
  }

  return {
    languages: TS_EXTENSIONS,

    async ready(): Promise<void> {
      state = "ready";
    },

    state: () => state,

    detect: async () => true,

    async hover(file, line, character): Promise<HoverResult | null> {
      try {
        state = "ready";
        const abs = absPath(file);
        const project = projectFor(abs);
        try {
          const pos = offsetOf(project, abs, line, character);
          if (pos === null) return null;
          const info = project.service.getQuickInfoAtPosition(abs, pos);
          if (!info) return null;

          const signature = ts.displayPartsToString(info.displayParts ?? []);
          const docs = ts.displayPartsToString(info.documentation ?? []).trim();
          const tags = (info.tags ?? [])
            .map(
              (t) =>
                `*@${t.name}*${t.text ? ` — ${ts.displayPartsToString(t.text)}` : ""}`,
            )
            .join("\n");
          const contents = [
            signature ? "```ts\n" + signature + "\n```" : "",
            docs,
            tags,
          ]
            .filter(Boolean)
            .join("\n\n");
          if (!contents) return null;

          const text = readFileSync(abs, "utf8");
          return { contents, range: rangeOf(text, info.textSpan) };
        } finally {
          trimCaches(project);
        }
      } catch {
        return null;
      }
    },

    async definition(file, line, character): Promise<DefResult[]> {
      try {
        state = "ready";
        const abs = absPath(file);
        const project = projectFor(abs);
        try {
          const pos = offsetOf(project, abs, line, character);
          if (pos === null) return [];
          const result = project.service.getDefinitionAndBoundSpan(abs, pos);
          if (!result?.definitions) return [];

          const out: DefResult[] = [];
          for (const def of result.definitions) {
            try {
              const text = readFileSync(def.fileName, "utf8");
              const range = rangeOf(text, def.textSpan);
              const previewLine = text.split("\n")[range.startLine - 1];
              out.push({
                file: toRelative(def.fileName),
                ...range,
                preview: previewLine?.trim(),
              });
            } catch {
              // Target unreadable (declaration in a virtual file etc.) — skip.
            }
          }
          return out;
        } finally {
          trimCaches(project);
        }
      } catch {
        return [];
      }
    },

    async diagnostics(file): Promise<Diag[]> {
      try {
        state = "ready";
        const abs = absPath(file);
        const project = projectFor(abs);
        try {
          // Mirror VS Code's default for plain JavaScript: semantic (type)
          // diagnostics only when the file opts into checking — checkJs in the
          // resolved tsconfig, or a leading `// @ts-check` pragma. Unchecked JS
          // still gets syntactic (parse) diagnostics.
          let checkSemantics = true;
          if (JS_FILE.test(abs) && project.options.checkJs !== true) {
            let text = "";
            try {
              text = readFileSync(abs, "utf8");
            } catch {
              /* missing file: no pragma, syntactic pass reports nothing */
            }
            checkSemantics = hasTsCheckPragma(text);
          }
          const all = [
            ...project.service.getSyntacticDiagnostics(abs),
            ...(checkSemantics ? project.service.getSemanticDiagnostics(abs) : []),
          ];
          const out: Diag[] = [];
          for (const d of all) {
            if (isEnvironmentDiagnostic(d)) continue;
            const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
            if (d.file && typeof d.start === "number") {
              const range = rangeOf(d.file.text, {
                start: d.start,
                length: d.length ?? 0,
              });
              out.push({ ...range, severity: severityOf(d.category), message, source: "ts" });
            } else {
              out.push({
                startLine: 1,
                startCol: 1,
                endLine: 1,
                endCol: 1,
                severity: severityOf(d.category),
                message,
                source: "ts",
              });
            }
          }
          return out;
        } finally {
          trimCaches(project);
        }
      } catch {
        return [];
      }
    },

    stats: () => ({ projects: { count: projects.size, max: maxProjects } }),

    async dispose(): Promise<void> {
      for (const p of projects.values()) disposeProject(p);
      projects.clear();
      mruOrder = [];
      state = "off";
    },
  };
}
