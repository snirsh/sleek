/**
 * Wave-5 content-addressed pipeline cache — a small SQLite KV in `.sleek/cache.db`,
 * deliberately SEPARATE from the threads store (src/store/store.ts): threads/reviews
 * are the Reviewer's data; everything here is a disposable derivation that can be
 * purged wholesale ({@link SleekCache.purge}, the future `sleek clean`).
 *
 * One table holds every kind of entry, discriminated by `kind`:
 *   - "gh-view"  `gh pr view` JSON, keyed (repoUrl, pr). Mutable upstream (new pushes
 *                move the head SHA), so reads pass a short TTL (~60s) — restarts within
 *                a session skip the network, new pushes are still seen. SLEEK_REFRESH=1
 *                bypasses the read at the call site (src/cache/gh.ts).
 *   - "gh-diff"  `gh pr diff` payload, keyed (repoUrl, pr, headSha). A PR's diff at a
 *                head SHA is immutable → cached forever (eviction only).
 *   - "context"  built ContextInput JSON, keyed (headSha, hash of the parsed regions).
 *                History + neighbors are deterministic per SHA.
 *   - "html"     rendered review page, keyed (pr, headSha, hash of scaffold JSON +
 *                diff, renderer-version). Renderer-version is a runtime hash of the
 *                src/render/*.ts sources ({@link rendererVersionHash}), so any landed
 *                renderer edit auto-invalidates — HTML is never served across edits.
 *
 * Every row carries a `schema_version`; bumping {@link CACHE_SCHEMA_VERSION} when a
 * cached JSON shape changes makes stale shapes self-invalidate (read as a miss and
 * deleted lazily). Eviction caps rows per kind and total bytes; the decision is the
 * pure {@link selectEvictions} so it is unit-testable.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

/** Bump when any cached JSON shape changes; every older row reads as a miss. */
export const CACHE_SCHEMA_VERSION = 1;

/** TTL for "gh-view" reads: restarts within a session skip gh, new pushes are seen. */
export const GH_VIEW_TTL_MS = 60_000;

// --- Keys ---------------------------------------------------------------------------

/** sha256 hex of `text` — the hash used for every content-addressed key part. */
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function ghViewKey(repoUrl: string, prNumber: number): string {
  return `${repoUrl}#${prNumber}`;
}

export function ghDiffKey(repoUrl: string, prNumber: number, headSha: string): string {
  return `${repoUrl}#${prNumber}#${headSha}`;
}

export function contextInputKey(headSha: string, regionsHash: string): string {
  return `${headSha}#${regionsHash}`;
}

export function htmlKey(
  prNumber: number,
  headSha: string,
  dataHash: string,
  rendererVersion: string,
): string {
  return `${prNumber}#${headSha}#${dataHash}#${rendererVersion}`;
}

// --- Renderer version ----------------------------------------------------------------

let rendererVersionMemo: string | null = null;

/**
 * A version hash of the renderer: sha256 over the (sorted) file names + contents of
 * every `.ts` under src/render/. Computed at runtime (~a dozen small files, one-off
 * per process) and folded into the "html" key, so cached HTML self-invalidates the
 * moment any renderer source changes on disk — never serves output from an older
 * renderer. `renderDir` is injectable for tests; defaults to src/render next door.
 */
export function rendererVersionHash(renderDir?: string): string {
  if (renderDir === undefined && rendererVersionMemo !== null) return rendererVersionMemo;
  const dir = renderDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "render");
  const hash = createHash("sha256");
  const names = readdirSync(dir)
    .filter((n) => n.endsWith(".ts"))
    .sort();
  for (const name of names) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(join(dir, name)));
    hash.update("\0");
  }
  const digest = hash.digest("hex");
  if (renderDir === undefined) rendererVersionMemo = digest;
  return digest;
}

// --- TTL + eviction decisions (pure) ---------------------------------------------------

/** Is a row written at `createdAtMs` still fresh at `nowMs`? No TTL → always fresh. */
export function isFresh(
  createdAtMs: number,
  nowMs: number,
  ttlMs: number | undefined,
): boolean {
  return ttlMs === undefined || nowMs - createdAtMs <= ttlMs;
}

/** The metadata eviction decides over (never the values themselves). */
export interface CacheRowMeta {
  kind: string;
  key: string;
  bytes: number;
  createdAtMs: number;
}

export interface EvictionCaps {
  /** Keep at most this many rows per kind (newest win). */
  maxRowsPerKind: number;
  /** Keep total stored bytes at or under this (oldest rows dropped first). */
  maxTotalBytes: number;
}

/** Roomy for text payloads; a monorepo PR diff + HTML page are a few MB each. */
export const DEFAULT_EVICTION_CAPS: EvictionCaps = {
  maxRowsPerKind: 16,
  maxTotalBytes: 256 * 1024 * 1024,
};

/**
 * Pure eviction decision: which rows to delete so that (a) each kind keeps only its
 * `maxRowsPerKind` newest rows and (b) the surviving total is ≤ `maxTotalBytes`
 * (dropping oldest-first across kinds). Ties on age break by key for determinism.
 */
export function selectEvictions(
  rows: CacheRowMeta[],
  caps: EvictionCaps,
): { kind: string; key: string }[] {
  const newestFirst = [...rows].sort(
    (a, b) => b.createdAtMs - a.createdAtMs || a.key.localeCompare(b.key),
  );

  const perKindSeen = new Map<string, number>();
  const evicted: CacheRowMeta[] = [];
  const kept: CacheRowMeta[] = [];
  for (const row of newestFirst) {
    const seen = perKindSeen.get(row.kind) ?? 0;
    perKindSeen.set(row.kind, seen + 1);
    (seen < caps.maxRowsPerKind ? kept : evicted).push(row);
  }

  // Byte cap over the survivors: walk oldest-first, dropping until under the cap.
  let total = kept.reduce((sum, r) => sum + r.bytes, 0);
  for (let i = kept.length - 1; i >= 0 && total > caps.maxTotalBytes; i--) {
    const row = kept[i]!;
    evicted.push(row);
    total -= row.bytes;
  }

  return evicted.map(({ kind, key }) => ({ kind, key }));
}

// --- The cache ------------------------------------------------------------------------

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS cache (
  kind           TEXT    NOT NULL,
  key            TEXT    NOT NULL,
  schema_version INTEGER NOT NULL,
  value          TEXT    NOT NULL,
  bytes          INTEGER NOT NULL,
  created_at_ms  INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);
`;

export interface SleekCache {
  /**
   * The cached value, or null on a miss. A row whose schema_version differs from the
   * cache's, or whose age exceeds `opts.ttlMs`, is a miss (and is deleted lazily).
   */
  get(kind: string, key: string, opts?: { ttlMs?: number }): string | null;
  /** Upsert a value (refreshing created-at), then apply the eviction caps. */
  set(kind: string, key: string, value: string): void;
  /** Drop every row — the `sleek clean` purge (future CLI wave imports this). */
  purge(): void;
  close(): void;
}

interface CacheRow {
  schema_version: number;
  value: string;
  created_at_ms: number;
}

/**
 * Open (creating if needed) the pipeline cache at `dbPath` (`":memory:"` in tests).
 * `caps`, `schemaVersion`, and `now` are injectable for tests.
 */
export function openCache(
  dbPath: string,
  opts: {
    caps?: EvictionCaps;
    schemaVersion?: number;
    now?: () => number;
  } = {},
): SleekCache {
  const caps = opts.caps ?? DEFAULT_EVICTION_CAPS;
  const schemaVersion = opts.schemaVersion ?? CACHE_SCHEMA_VERSION;
  const now = opts.now ?? Date.now;

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  // Wave 9B: the scaffold worker (src/review/scaffoldWorker.ts) opens its OWN
  // connection to this same cache.db while the parent server may also touch it.
  // WAL lets a reader and a writer coexist, but two writers still serialize; a
  // busy_timeout makes the loser wait-and-retry instead of throwing
  // "database is locked" (the crasher observed in Wave 9's grounded defects).
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_DDL);

  const selectRow = db.prepare<[string, string]>(
    `SELECT schema_version, value, created_at_ms FROM cache WHERE kind = ? AND key = ?`,
  );
  const upsertRow = db.prepare<[string, string, number, string, number, number]>(
    `INSERT INTO cache (kind, key, schema_version, value, bytes, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, key)
     DO UPDATE SET schema_version = excluded.schema_version, value = excluded.value,
                   bytes = excluded.bytes, created_at_ms = excluded.created_at_ms`,
  );
  const deleteRow = db.prepare<[string, string]>(
    `DELETE FROM cache WHERE kind = ? AND key = ?`,
  );
  const selectMeta = db.prepare(
    `SELECT kind, key, bytes, created_at_ms FROM cache`,
  );
  const deleteAll = db.prepare(`DELETE FROM cache`);

  function evict(): void {
    const rows = (selectMeta.all() as {
      kind: string;
      key: string;
      bytes: number;
      created_at_ms: number;
    }[]).map((r) => ({
      kind: r.kind,
      key: r.key,
      bytes: r.bytes,
      createdAtMs: r.created_at_ms,
    }));
    for (const { kind, key } of selectEvictions(rows, caps)) {
      deleteRow.run(kind, key);
    }
  }

  return {
    get(kind, key, getOpts = {}) {
      const row = selectRow.get(kind, key) as CacheRow | undefined;
      if (!row) return null;
      if (
        row.schema_version !== schemaVersion ||
        !isFresh(row.created_at_ms, now(), getOpts.ttlMs)
      ) {
        deleteRow.run(kind, key); // self-invalidate: stale shape or expired TTL
        return null;
      }
      return row.value;
    },

    set(kind, key, value) {
      upsertRow.run(kind, key, schemaVersion, value, Buffer.byteLength(value), now());
      evict();
    },

    purge() {
      deleteAll.run();
    },

    close() {
      db.close();
    },
  };
}
