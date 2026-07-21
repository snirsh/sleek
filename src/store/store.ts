import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  parseReviewScaffold,
  type Anchor,
  type ReviewScaffold,
} from "../domain/scaffold.ts";
import {
  parseThread,
  type Comment,
  type Review,
  type ReviewVerdict,
  type Thread,
  type ThreadStatus,
} from "../domain/threads.ts";

/**
 * M4 Store — SQLite persistence for Review Scaffolds.
 *
 * See docs/PLAN.md §3 step 4 and §5 M4. A Review Scaffold (the Scaffolder's output,
 * M3) is expensive to produce, so we persist it keyed by (PR number + head SHA): the
 * head SHA is what makes a scaffold correct or STALE. The whole scaffold is stored as a
 * JSON blob (the domain schema is the source of truth; we don't shred it into columns)
 * alongside the few columns we query on — `prNumber`, `headSha`, `createdAt`.
 *
 * Staleness boundary (PLAN §5 M4): this module only REPORTS the fact — whether the
 * latest stored head SHA matches the current PR head SHA — via {@link Store.isStale}.
 * The POLICY (warn the Reviewer + offer a full re-scaffold, never auto-run) lives in the
 * UI/server layer (M6), not here. The store never decides what to do about staleness.
 *
 * Learnings (CONTEXT.md, ADR: Learning deferred) are a reserved concept. The schema
 * keeps a `learnings` table slot with a trivial insert/list, but there is deliberately
 * NO capture path or relevance matching in v1.
 */

// --- Schema (DDL) -------------------------------------------------------------------
// Kept as one string so the whole schema is visible in one place and applied atomically.
// The threads/comments table DDL is factored out because the legacy-schema migration
// (see migrateLegacyThreadTables) must create the same tables mid-migration.

// Wave 2 thread model (src/domain/threads.ts). Thread ids are TEXT keys that are
// deterministic and POSITIONAL for seeded finding-threads ("f-<layer>-<k>", matching
// the renderer's data-tid contract in src/render/html.ts), so they REPEAT across PRs —
// a thread is therefore keyed by (pr_number, head_sha, id), never by id alone.
// Reviewer-created threads get "t-<uuid>" ids.
const THREADS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS threads (
  pr_number  INTEGER NOT NULL,
  head_sha   TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  anchor     TEXT    NOT NULL,          -- Anchor as JSON
  status     TEXT    NOT NULL,          -- 'open' | 'resolved'
  created_at TEXT    NOT NULL,          -- ISO-8601 UTC timestamp
  PRIMARY KEY (pr_number, head_sha, id)
);
`;

// Seeded opening-comment ids ("f-<layer>-<k>-c0") are positional too, so comments
// carry the same (pr_number, head_sha) scope as their thread; the composite FK pins a
// comment to its thread within that scope while letting the pending/drain queries
// filter on comments alone (no join through threads).
const COMMENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS comments (
  pr_number  INTEGER NOT NULL,
  head_sha   TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  thread_id  TEXT    NOT NULL,
  author     TEXT    NOT NULL,          -- CommentAuthor as JSON
  body       TEXT    NOT NULL,          -- markdown
  pending    INTEGER NOT NULL,          -- 0 | 1
  concern    TEXT,                      -- finding-authored comments only
  severity   TEXT,                      -- finding-authored comments only
  visibility TEXT,                      -- reviewer-authored: 'publishable' | 'local'
  created_at TEXT    NOT NULL,          -- ISO-8601 UTC timestamp
  PRIMARY KEY (pr_number, head_sha, id),
  FOREIGN KEY (pr_number, head_sha, thread_id)
    REFERENCES threads (pr_number, head_sha, id)
);
`;

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS scaffolds (
  pr_number  INTEGER NOT NULL,
  head_sha   TEXT    NOT NULL,
  scaffold   TEXT    NOT NULL,          -- the whole ReviewScaffold as JSON
  created_at TEXT    NOT NULL,          -- ISO-8601 UTC timestamp
  PRIMARY KEY (pr_number, head_sha)
);

CREATE INDEX IF NOT EXISTS idx_scaffolds_pr_created
  ON scaffolds (pr_number, created_at DESC);

CREATE TABLE IF NOT EXISTS learnings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT    NOT NULL,
  created_at TEXT    NOT NULL           -- ISO-8601 UTC timestamp
);

${THREADS_TABLE_DDL}

${COMMENTS_TABLE_DDL}

CREATE INDEX IF NOT EXISTS idx_comments_thread
  ON comments (pr_number, head_sha, thread_id);

CREATE TABLE IF NOT EXISTS reviews (
  pr_number    INTEGER NOT NULL,
  head_sha     TEXT    NOT NULL,
  verdict      TEXT    NOT NULL,        -- 'approve' | 'request_changes' | 'comment'
  summary      TEXT    NOT NULL,        -- markdown
  submitted_at TEXT    NOT NULL,        -- ISO-8601 UTC timestamp
  PRIMARY KEY (pr_number, head_sha)
);

-- Wave 4A: the record that a submitted Review was posted to the real GitHub PR
-- (POST /api/review/export). A separate table (not columns on reviews) keeps the
-- migration purely additive: CREATE TABLE IF NOT EXISTS on open is all it takes.
CREATE TABLE IF NOT EXISTS review_exports (
  pr_number        INTEGER NOT NULL,
  head_sha         TEXT    NOT NULL,
  github_review_id INTEGER NOT NULL,   -- GitHub's review id from the POST response
  url              TEXT,               -- the review's html_url, when GitHub returned one
  exported_at      TEXT    NOT NULL,   -- ISO-8601 UTC timestamp
  PRIMARY KEY (pr_number, head_sha)
);

-- Wave 4C: saved replies — the Reviewer's reusable comment templates. GLOBAL
-- (no pr_number/head_sha): templates belong to the Reviewer, not to any one PR.
CREATE TABLE IF NOT EXISTS saved_replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,          -- markdown
  created_at TEXT    NOT NULL           -- ISO-8601 UTC timestamp
);

-- Wave 7: model choices per PR (assistant Ollama model + scaffolder model/replay choice).
-- Additive — no migration needed; existing databases gain the table on first open.
CREATE TABLE IF NOT EXISTS model_choices (
  pr_number        INTEGER PRIMARY KEY,
  assistant_model  TEXT,                -- Ollama tag chosen for this PR
  scaffolder_model TEXT,                -- anthropic model id or 'replay'
  updated_at       TEXT NOT NULL        -- ISO-8601 UTC timestamp of last update
);

-- Wave 3A: partial flag on scaffolds — 1 when the scaffold is a skeleton-only placeholder.
-- Separate table so the migration is purely additive (no ALTER TABLE needed).
CREATE TABLE IF NOT EXISTS scaffold_partial (
  pr_number  INTEGER NOT NULL,
  head_sha   TEXT    NOT NULL,
  partial    INTEGER NOT NULL DEFAULT 0,   -- 1 = partial (skeleton only), 0 = complete
  PRIMARY KEY (pr_number, head_sha)
);

-- Wave 3B: per-run phase timings for ETA estimation. Keyed by size bucket.
CREATE TABLE IF NOT EXISTS run_timings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket     TEXT    NOT NULL,   -- e.g. "files:10-49,regions:25-99"
  phase      TEXT    NOT NULL,   -- 'ingest'|'skeleton'|'detail'|'total'
  ms         INTEGER NOT NULL,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_timings_bucket_phase
  ON run_timings (bucket, phase, created_at DESC);
`;

/** A stored scaffold with the metadata the store tracks alongside the JSON blob. */
export interface StoredScaffold {
  scaffold: ReviewScaffold;
  headSha: string;
  createdAt: string;
}

/** A placeholder Learning row. Learnings capture is deferred (see module doc). */
export interface Learning {
  id: number;
  text: string;
  createdAt: string;
}

/**
 * A Comment as callers supply it: the store assigns `id` and `createdAt`.
 * Finding-authored inputs must carry `concern` + `severity` (domain refinement).
 */
export type CommentInput = Omit<Comment, "id" | "createdAt">;

/**
 * The record of a Review posted to the real GitHub PR (Wave 4A export).
 * One per (prNumber, headSha) — the same key as the Review it mirrors.
 */
export interface ExportRecord {
  /** GitHub's review id from the POST /pulls/{pr}/reviews response. */
  githubReviewId: number;
  /** The GitHub review's html_url, or null when the response carried none. */
  url: string | null;
  /** ISO-8601 UTC timestamp of the successful post. */
  exportedAt: string;
}

/**
 * The persisted model choices for a PR (Wave 7). Both fields are nullable: a
 * PR may have an assistant model choice but no scaffolder choice, or vice versa.
 */
export interface ModelChoices {
  assistantModel: string | null;
  scaffolderModel: string | null;
}

/**
 * One stored scaffold VERSION of a PR — key columns only, no scaffold blob
 * (Wave 4B versions-lite). See {@link Store.listScaffoldVersions}.
 */
export interface ScaffoldVersion {
  headSha: string;
  createdAt: string;
}

/**
 * A saved reply (Wave 4C): a reusable comment template the Reviewer inserts
 * into thread composers/editors. GLOBAL — not keyed by PR.
 */
export interface SavedReply {
  id: number;
  title: string;
  body: string;
  createdAt: string;
}

/** The result of a staleness check. See {@link Store.isStale} and the module doc. */
export interface StalenessReport {
  /** True when the latest stored scaffold's head SHA differs from the current one. */
  stale: boolean;
  /** The latest stored head SHA, or null when no scaffold exists for the PR. */
  storedHeadSha: string | null;
}

/**
 * Cross-PR summary row for {@link Store.listAllPrs}. Key columns only — the
 * scaffold JSON blobs are never loaded (Wave 6 `sleek list`).
 */
export interface PrSummary {
  prNumber: number;
  versions: number;
  latestHeadSha: string;
  latestCreatedAt: string;
}

/**
 * The persistence surface for Review Scaffolds. Obtain one via {@link openStore}.
 * All methods use prepared, parameterized statements — no SQL string interpolation.
 */
export interface Store {
  /**
   * Persist a scaffold, keyed by (prNumber, headSha). Saving the same key twice
   * REPLACES the existing row (upsert) rather than duplicating it; `createdAt` is
   * refreshed to the time of the latest save.
   */
  saveScaffold(scaffold: ReviewScaffold): void;

  /**
   * Fetch the scaffold for an exact (prNumber, headSha), or null if absent.
   * The stored JSON is re-validated through {@link parseReviewScaffold}, so a corrupt
   * row throws clearly rather than returning a malformed object.
   */
  getScaffold(prNumber: number, headSha: string): ReviewScaffold | null;

  /**
   * The most recent scaffold for a PR regardless of head SHA, or null if none exist.
   * "Most recent" is by `createdAt` (ties broken by head SHA for determinism).
   */
  getLatestForPr(prNumber: number): StoredScaffold | null;

  /**
   * All stored scaffold versions for a PR, newest first (by `createdAt`, ties
   * broken by head SHA descending — the same order getLatestForPr resolves
   * "most recent" by). Key columns ONLY: the scaffold JSON blobs are big and
   * this powers a version list, so they are never read here (Wave 4B).
   */
  listScaffoldVersions(prNumber: number): ScaffoldVersion[];

  /**
   * All PRs that have at least one stored scaffold, ordered by latest scaffold
   * descending. Key columns only — scaffold JSON blobs are never loaded (Wave 6).
   * SQL: GROUP BY pr_number, aggregate version count + latest (head_sha, created_at).
   */
  listAllPrs(): PrSummary[];

  /**
   * Report whether the latest stored scaffold for a PR is stale relative to the
   * current PR head SHA. This reports the FACT only; the warn/re-scaffold POLICY
   * lives in the UI/server (see module doc). A PR with no stored scaffold is not
   * "stale" (there is nothing to be stale against): `{ stale: false, storedHeadSha: null }`.
   */
  isStale(prNumber: number, currentHeadSha: string): StalenessReport;

  /** Insert a placeholder Learning. Deferred feature — trivial persistence only. */
  addLearning(text: string): Learning;

  /** List placeholder Learnings, newest first. Deferred feature — no relevance matching. */
  listLearnings(): Learning[];

  // ── Threads & Review (Wave 2; src/domain/threads.ts) ──────────────────────────────

  /**
   * Create one open Thread per Finding of the scaffold, keyed by the UI's
   * deterministic finding id: `f-<li>-<k>` where `li` is the Layer's index in
   * reading order (layers sorted by `order`, matching src/render/html.ts) and
   * `k` is the Finding's index within that Layer. The opening Comment is
   * finding-authored (body = finding text, with concern + severity,
   * pending=false, deterministic id `f-<li>-<k>-c0`).
   *
   * Idempotent per (pr, headSha): a finding whose (pr, headSha, thread id)
   * already exists is skipped, so re-seeding on every server start is safe.
   * Positional ids repeat across PRs/SHAs by design; threads are keyed by
   * (pr_number, head_sha, id), so seeding a different PR (or a re-scaffold at
   * a new head SHA) into the same db always seeds fully.
   */
  seedFindingThreads(scaffold: ReviewScaffold): void;

  /** All Threads for (pr, headSha), oldest first; comments in insertion order. */
  listThreads(prNumber: number, headSha: string): Thread[];

  /** A single Thread by (pr, headSha, id), or null if absent. */
  getThread(prNumber: number, headSha: string, threadId: string): Thread | null;

  /**
   * Create a new Thread at `anchor` whose opening Comment is `comment`
   * (typically reviewer-authored, pending=true). Ids are generated
   * (`t-<uuid>` / `c-<uuid>`).
   */
  createThread(
    prNumber: number,
    headSha: string,
    anchor: Anchor,
    comment: CommentInput,
  ): Thread;

  /**
   * Append a Comment to the (pr, headSha, threadId) Thread. Throws if the
   * thread is absent.
   */
  addComment(
    prNumber: number,
    headSha: string,
    threadId: string,
    comment: CommentInput,
  ): Comment;

  /**
   * Set the (pr, headSha, threadId) Thread open/resolved. Throws if the
   * thread is absent.
   */
  setThreadStatus(
    prNumber: number,
    headSha: string,
    threadId: string,
    status: ThreadStatus,
  ): void;

  /**
   * Update a Comment's reviewer visibility. Returns the updated Comment, or
   * null when the scoped thread/comment key does not exist. Author policy lives
   * in the server layer.
   */
  setCommentVisibility(
    prNumber: number,
    headSha: string,
    threadId: string,
    commentId: string,
    visibility: NonNullable<Comment["visibility"]>,
  ): Comment | null;

  /**
   * Replace a Comment's body. Returns the updated Comment, or null when the
   * scoped thread/comment key does not exist. Author/pending policy (only
   * pending reviewer drafts are editable) lives in the server layer.
   */
  editComment(
    prNumber: number,
    headSha: string,
    threadId: string,
    commentId: string,
    body: string,
  ): Comment | null;

  /**
   * Delete a Comment. When it was the last Comment in its Thread, the Thread is
   * deleted too (so a reviewer-created thread vanishes with its only draft,
   * while a finding thread survives — its finding Comment remains). Returns
   * whether a row was deleted and whether the Thread was removed. Author/pending
   * policy lives in the server layer.
   */
  deleteComment(
    prNumber: number,
    headSha: string,
    threadId: string,
    commentId: string,
  ): { deleted: boolean; threadDeleted: boolean };

  /** All pending Comments across the (pr, headSha) threads, insertion order. */
  pendingComments(prNumber: number, headSha: string): Comment[];

  /**
   * Submit the Review for (pr, headSha): marks every pending Comment in its
   * threads non-pending and stores (upserting) the Review. Returns it.
   */
  submitReview(
    prNumber: number,
    headSha: string,
    verdict: ReviewVerdict,
    summary: string,
  ): Review;

  /** The submitted Review for (pr, headSha), or null when none exists. */
  getReview(prNumber: number, headSha: string): Review | null;

  /**
   * Record that the (pr, headSha) Review was posted to GitHub. Upserts (a
   * re-post after e.g. a deleted GitHub review replaces the record) and
   * returns the stored {@link ExportRecord}.
   */
  recordExport(
    prNumber: number,
    headSha: string,
    result: { githubReviewId: number; url?: string | null },
  ): ExportRecord;

  /** The export record for (pr, headSha), or null when never posted. */
  getExport(prNumber: number, headSha: string): ExportRecord | null;

  // ── Saved replies (Wave 4C; global — the Reviewer's templates) ─────────────────────

  /** All saved replies, oldest first (stable creation order — muscle memory). */
  listSavedReplies(): SavedReply[];

  /** Persist a new saved reply; the store assigns `id` and `createdAt`. */
  createSavedReply(title: string, body: string): SavedReply;

  /**
   * Delete a saved reply by id. Returns whether a row was deleted — the store
   * reports the fact; the 404-vs-200 policy lives in the server layer.
   */
  deleteSavedReply(id: number): boolean;

  // ── Scaffold partial + run timings (Wave 3) ─────────────────────────────────────────

  /** Mark a scaffold as partial (skeleton only, findings not yet available). Wave 3A. */
  setScaffoldPartial(prNumber: number, headSha: string, partial: boolean): void;

  /** Return whether the scaffold for (prNumber, headSha) is partial, or null if no scaffold. */
  getScaffoldPartial(prNumber: number, headSha: string): boolean | null;

  /** Record a completed phase timing for future ETA estimates. Wave 3B. */
  recordRunTiming(bucket: string, phase: string, ms: number): void;

  /** Median ms for (bucket, phase) from the last N=20 runs, or null if fewer than 2 samples. */
  medianRunMs(bucket: string, phase: string): number | null;

  // ── Model choices (Wave 7; per PR) ─────────────────────────────────────────────────

  /**
   * Return the persisted model choices for a PR, or null when no row exists.
   * Either field may be null if only one side has been set.
   */
  getModelChoices(prNumber: number): ModelChoices | null;

  /**
   * Partial-upsert the model choices for a PR. Only supplied fields are written;
   * an omitted field preserves the existing stored value (COALESCE in SQL).
   */
  saveModelChoices(prNumber: number, choices: { assistantModel?: string; scaffolderModel?: string }): void;

  /** Close the underlying database handle. */
  close(): void;
}

/** Row shape for the scaffolds table (snake_case as stored). */
interface ScaffoldRow {
  head_sha: string;
  scaffold: string;
  created_at: string;
}

interface LearningRow {
  id: number;
  text: string;
  created_at: string;
}

interface ThreadRow {
  id: string;
  anchor: string;
  status: string;
  created_at: string;
}

interface CommentRow {
  id: string;
  author: string;
  body: string;
  pending: number;
  concern: string | null;
  severity: string | null;
  visibility: string | null;
  created_at: string;
}

/** Rebuild a Comment object (unvalidated) from its row. */
function commentFromRow(r: CommentRow): Comment {
  return {
    id: r.id,
    author: JSON.parse(r.author) as Comment["author"],
    body: r.body,
    createdAt: r.created_at,
    pending: r.pending === 1,
    ...(r.concern !== null ? { concern: r.concern as Comment["concern"] } : {}),
    ...(r.severity !== null
      ? { severity: r.severity as Comment["severity"] }
      : {}),
    ...(r.visibility !== null
      ? { visibility: r.visibility as Comment["visibility"] }
      : {}),
  };
}

/** One row of `PRAGMA table_info(...)` — only the fields the migration check reads. */
interface TableInfoRow {
  name: string;
  pk: number;
}

/**
 * Migrate a database whose threads/comments tables predate the composite
 * (pr_number, head_sha, id) key. The legacy schema had `threads.id` as a GLOBAL
 * primary key, which silently dropped seeded finding-threads for a second PR
 * whose positional ids collided with the first's (and `comments.id` global too).
 *
 * Detection: in the legacy threads table `pr_number` is an ordinary column
 * (pk = 0 in PRAGMA table_info); in the composite schema it is part of the
 * primary key (pk = 1). No threads table at all means a fresh db — nothing to do.
 *
 * The copy is mechanical because legacy thread rows already carried
 * pr_number/head_sha: rename both tables aside, recreate them with the composite
 * keys, copy threads across, and copy comments joined through their legacy thread
 * to inherit its (pr_number, head_sha). `ORDER BY rowid` on both copies preserves
 * insertion order, which listThreads/comment ordering rely on. All inside one
 * transaction: an interrupted migration leaves the legacy db untouched. Runs
 * before `foreign_keys = ON`, so the legacy comments→threads FK never trips
 * mid-rename.
 */
function migrateLegacyThreadTables(db: Database.Database): void {
  const columns = db.pragma("table_info(threads)") as TableInfoRow[];
  if (columns.length === 0) return; // fresh db — SCHEMA_DDL will create the tables
  const prNumber = columns.find((c) => c.name === "pr_number");
  if (!prNumber || prNumber.pk > 0) return; // already the composite schema

  db.transaction(() => {
    db.exec(`
      ALTER TABLE threads RENAME TO threads_legacy;
      ALTER TABLE comments RENAME TO comments_legacy;

      ${THREADS_TABLE_DDL}

      ${COMMENTS_TABLE_DDL}

      INSERT INTO threads (pr_number, head_sha, id, anchor, status, created_at)
        SELECT pr_number, head_sha, id, anchor, status, created_at
        FROM threads_legacy
        ORDER BY rowid;

      INSERT INTO comments
        (pr_number, head_sha, id, thread_id, author, body, pending, concern, severity, created_at)
        SELECT t.pr_number, t.head_sha, c.id, c.thread_id, c.author, c.body,
               c.pending, c.concern, c.severity, c.created_at
        FROM comments_legacy c JOIN threads_legacy t ON t.id = c.thread_id
        ORDER BY c.rowid;

      DROP TABLE comments_legacy;
      DROP TABLE threads_legacy;
    `);
  })();
}

/** Add Wave-8 nullable comment columns to already-composite databases. */
function migrateCommentVisibilityColumn(db: Database.Database): void {
  const columns = db.pragma("table_info(comments)") as TableInfoRow[];
  if (columns.length === 0) return; // fresh db — SCHEMA_DDL will create the table
  if (columns.some((c) => c.name === "visibility")) return;
  db.exec(`ALTER TABLE comments ADD COLUMN visibility TEXT`);
}

/**
 * Open (and initialize, if needed) the SQLite scaffold store at `dbPath`.
 * Pass `":memory:"` for an ephemeral in-memory database (used by tests). The schema is
 * created if absent, so opening a fresh path just works; a legacy pre-composite-key
 * threads schema is migrated in place (see {@link migrateLegacyThreadTables}).
 */
export function openStore(dbPath: string): Store {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  // Two writers still serialize under WAL; a busy_timeout makes the loser
  // wait-and-retry instead of throwing SQLITE_BUSY (same convention as cache.ts).
  db.pragma("busy_timeout = 5000");
  migrateLegacyThreadTables(db);
  migrateCommentVisibilityColumn(db);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_DDL);

  const insertScaffold = db.prepare<[number, string, string, string]>(
    `INSERT INTO scaffolds (pr_number, head_sha, scaffold, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (pr_number, head_sha)
     DO UPDATE SET scaffold = excluded.scaffold, created_at = excluded.created_at`,
  );

  const selectByKey = db.prepare<[number, string]>(
    `SELECT head_sha, scaffold, created_at FROM scaffolds
     WHERE pr_number = ? AND head_sha = ?`,
  );

  const selectLatest = db.prepare<[number]>(
    `SELECT head_sha, scaffold, created_at FROM scaffolds
     WHERE pr_number = ?
     ORDER BY created_at DESC, head_sha DESC
     LIMIT 1`,
  );

  // Wave 4B versions-lite: key columns only — the scaffold JSON blob is never
  // read by the version list (it can be hundreds of KB per row).
  const selectVersions = db.prepare<[number]>(
    `SELECT head_sha, created_at FROM scaffolds
     WHERE pr_number = ?
     ORDER BY created_at DESC, head_sha DESC`,
  );

  // Wave 6 cross-PR listing: GROUP BY so scaffold JSON blobs are never loaded.
  const selectAllPrs = db.prepare(
    `SELECT pr_number,
            COUNT(*) AS versions,
            MAX(created_at) AS latest_created_at,
            head_sha AS latest_head_sha
     FROM (
       SELECT pr_number, head_sha, created_at
       FROM scaffolds
       ORDER BY created_at DESC, head_sha DESC
     )
     GROUP BY pr_number
     ORDER BY latest_created_at DESC`,
  );

  const insertLearning = db.prepare<[string, string]>(
    `INSERT INTO learnings (text, created_at) VALUES (?, ?)`,
  );

  const selectLearnings = db.prepare(
    `SELECT id, text, created_at FROM learnings ORDER BY created_at DESC, id DESC`,
  );

  // ── Threads & Review statements ─────────────────────────────────────────────────
  // Threads and comments are keyed by (pr_number, head_sha, id) — seeded positional
  // ids repeat across PRs, so every lookup carries the (pr, sha) scope.

  const insertThreadIgnore = db.prepare<[number, string, string, string, string, string]>(
    `INSERT INTO threads (pr_number, head_sha, id, anchor, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (pr_number, head_sha, id) DO NOTHING`,
  );

  const insertThread = db.prepare<[number, string, string, string, string, string]>(
    `INSERT INTO threads (pr_number, head_sha, id, anchor, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const selectThreadsForPr = db.prepare<[number, string]>(
    `SELECT id, anchor, status, created_at FROM threads
     WHERE pr_number = ? AND head_sha = ?
     ORDER BY rowid`,
  );

  const selectThreadByKey = db.prepare<[number, string, string]>(
    `SELECT id, anchor, status, created_at FROM threads
     WHERE pr_number = ? AND head_sha = ? AND id = ?`,
  );

  const updateThreadStatus = db.prepare<[string, number, string, string]>(
    `UPDATE threads SET status = ?
     WHERE pr_number = ? AND head_sha = ? AND id = ?`,
  );

  const insertComment = db.prepare<
    [
      number,
      string,
      string,
      string,
      string,
      string,
      number,
      string | null,
      string | null,
      string | null,
      string,
    ]
  >(
    `INSERT INTO comments
       (pr_number, head_sha, id, thread_id, author, body, pending, concern, severity, visibility, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const selectCommentsForThread = db.prepare<[number, string, string]>(
    `SELECT id, author, body, pending, concern, severity, visibility, created_at
     FROM comments
     WHERE pr_number = ? AND head_sha = ? AND thread_id = ?
     ORDER BY rowid`,
  );

  const selectPendingComments = db.prepare<[number, string]>(
    `SELECT id, author, body, pending, concern, severity, visibility, created_at
     FROM comments
     WHERE pr_number = ? AND head_sha = ? AND pending = 1
     ORDER BY rowid`,
  );

  const updateCommentVisibility = db.prepare<
    [string, number, string, string, string]
  >(
    `UPDATE comments SET visibility = ?
     WHERE pr_number = ? AND head_sha = ? AND thread_id = ? AND id = ?`,
  );

  const selectCommentByKey = db.prepare<[number, string, string, string]>(
    `SELECT id, author, body, pending, concern, severity, visibility, created_at
     FROM comments
     WHERE pr_number = ? AND head_sha = ? AND thread_id = ? AND id = ?`,
  );

  const updateCommentBody = db.prepare<[string, number, string, string, string]>(
    `UPDATE comments SET body = ?
     WHERE pr_number = ? AND head_sha = ? AND thread_id = ? AND id = ?`,
  );

  const deleteCommentStmt = db.prepare<[number, string, string, string]>(
    `DELETE FROM comments
     WHERE pr_number = ? AND head_sha = ? AND thread_id = ? AND id = ?`,
  );

  const countCommentsForThread = db.prepare<[number, string, string]>(
    `SELECT COUNT(*) AS n FROM comments
     WHERE pr_number = ? AND head_sha = ? AND thread_id = ?`,
  );

  const deleteThreadStmt = db.prepare<[number, string, string]>(
    `DELETE FROM threads WHERE pr_number = ? AND head_sha = ? AND id = ?`,
  );

  const drainPendingComments = db.prepare<[number, string]>(
    `UPDATE comments SET pending = 0
     WHERE pr_number = ? AND head_sha = ? AND pending = 1`,
  );

  const upsertReview = db.prepare<[number, string, string, string, string]>(
    `INSERT INTO reviews (pr_number, head_sha, verdict, summary, submitted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (pr_number, head_sha)
     DO UPDATE SET verdict = excluded.verdict, summary = excluded.summary,
                   submitted_at = excluded.submitted_at`,
  );

  const selectReview = db.prepare<[number, string]>(
    `SELECT verdict, summary, submitted_at FROM reviews
     WHERE pr_number = ? AND head_sha = ?`,
  );

  const upsertExport = db.prepare<[number, string, number, string | null, string]>(
    `INSERT INTO review_exports (pr_number, head_sha, github_review_id, url, exported_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (pr_number, head_sha)
     DO UPDATE SET github_review_id = excluded.github_review_id,
                   url = excluded.url, exported_at = excluded.exported_at`,
  );

  const selectExport = db.prepare<[number, string]>(
    `SELECT github_review_id, url, exported_at FROM review_exports
     WHERE pr_number = ? AND head_sha = ?`,
  );

  // ── Saved replies statements (Wave 4C; global table, no (pr, sha) scope) ─────────
  const insertSavedReply = db.prepare<[string, string, string]>(
    `INSERT INTO saved_replies (title, body, created_at) VALUES (?, ?, ?)`,
  );

  const selectSavedReplies = db.prepare(
    `SELECT id, title, body, created_at FROM saved_replies ORDER BY id`,
  );

  const deleteSavedReplyStmt = db.prepare<[number]>(
    `DELETE FROM saved_replies WHERE id = ?`,
  );

  // ── Wave 3A: scaffold_partial statements ────────────────────────────────────────────
  const upsertScaffoldPartial = db.prepare<[number, string, number]>(
    `INSERT INTO scaffold_partial (pr_number, head_sha, partial)
     VALUES (?, ?, ?)
     ON CONFLICT (pr_number, head_sha)
     DO UPDATE SET partial = excluded.partial`,
  );

  const selectScaffoldPartial = db.prepare<[number, string]>(
    `SELECT partial FROM scaffold_partial WHERE pr_number = ? AND head_sha = ?`,
  );

  // ── Wave 3B: run_timings statements ─────────────────────────────────────────────────
  const insertRunTiming = db.prepare<[string, string, number, string]>(
    `INSERT INTO run_timings (bucket, phase, ms, created_at) VALUES (?, ?, ?, ?)`,
  );

  const selectRunTimings = db.prepare<[string, string]>(
    `SELECT ms FROM run_timings WHERE bucket = ? AND phase = ?
     ORDER BY created_at DESC LIMIT 20`,
  );

  // ── Model choices statements (Wave 7; keyed by pr_number only) ─────────────────────
  const selectModelChoices = db.prepare<[number]>(
    `SELECT assistant_model, scaffolder_model FROM model_choices WHERE pr_number = ?`,
  );

  const upsertModelChoices = db.prepare<[number, string | null, string | null, string]>(
    `INSERT INTO model_choices (pr_number, assistant_model, scaffolder_model, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (pr_number)
     DO UPDATE SET
       assistant_model  = COALESCE(excluded.assistant_model,  model_choices.assistant_model),
       scaffolder_model = COALESCE(excluded.scaffolder_model, model_choices.scaffolder_model),
       updated_at       = excluded.updated_at`,
  );

  /** Persist one comment row from a CommentInput; returns the built Comment. */
  function writeComment(
    prNumber: number,
    headSha: string,
    id: string,
    threadId: string,
    input: CommentInput,
  ): Comment {
    const createdAt = new Date().toISOString();
    insertComment.run(
      prNumber,
      headSha,
      id,
      threadId,
      JSON.stringify(input.author),
      input.body,
      input.pending ? 1 : 0,
      input.concern ?? null,
      input.severity ?? null,
      input.visibility ?? null,
      createdAt,
    );
    return {
      id,
      author: input.author,
      body: input.body,
      createdAt,
      pending: input.pending,
      ...(input.concern !== undefined ? { concern: input.concern } : {}),
      ...(input.severity !== undefined ? { severity: input.severity } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
    };
  }

  /**
   * Rebuild + re-validate a Thread from its row (parseThread throws on a
   * corrupt row rather than leaking a malformed object — same guard as
   * getScaffold).
   */
  function threadFromRow(
    prNumber: number,
    headSha: string,
    row: ThreadRow,
  ): Thread {
    const comments = (
      selectCommentsForThread.all(prNumber, headSha, row.id) as CommentRow[]
    ).map(commentFromRow);
    return parseThread({
      id: row.id,
      anchor: JSON.parse(row.anchor) as Anchor,
      status: row.status,
      comments,
    });
  }

  const seedFindingThreadsTx = db.transaction((scaffold: ReviewScaffold) => {
    // Reading order — the same sort the renderer applies before assigning
    // `f-<li>-<k>` finding ids (src/render/html.ts), so ids line up 1:1.
    const layers = [...scaffold.layers].sort((a, b) => a.order - b.order);
    layers.forEach((layer, li) => {
      layer.findings.forEach((finding, k) => {
        const id = `f-${li}-${k}`;
        const now = new Date().toISOString();
        const info = insertThreadIgnore.run(
          scaffold.pr.number,
          scaffold.pr.headSha,
          id,
          JSON.stringify(finding.anchor),
          "open",
          now,
        );
        if (info.changes === 0) return; // already seeded for this (pr, sha) — idempotent skip
        writeComment(scaffold.pr.number, scaffold.pr.headSha, `${id}-c0`, id, {
          author: { type: "finding" },
          body: finding.text,
          pending: false,
          concern: finding.concern,
          severity: finding.severity,
        });
      });
    });
  });

  const store: Store = {
    saveScaffold(scaffold) {
      if (scaffold.layers.length === 0) {
        throw new Error(
          "saveScaffold: empty scaffold (layers: []) must not be persisted — " +
          "call saveScaffold only after a successful scaffold run that produced layers.",
        );
      }
      insertScaffold.run(
        scaffold.pr.number,
        scaffold.pr.headSha,
        JSON.stringify(scaffold),
        new Date().toISOString(),
      );
    },

    getScaffold(prNumber, headSha) {
      const row = selectByKey.get(prNumber, headSha) as ScaffoldRow | undefined;
      if (!row) return null;
      // Re-validate: a corrupt/stale-shape blob throws (ZodError) rather than leaking out.
      return parseReviewScaffold(JSON.parse(row.scaffold));
    },

    getLatestForPr(prNumber) {
      const row = selectLatest.get(prNumber) as ScaffoldRow | undefined;
      if (!row) return null;
      return {
        scaffold: parseReviewScaffold(JSON.parse(row.scaffold)),
        headSha: row.head_sha,
        createdAt: row.created_at,
      };
    },

    listScaffoldVersions(prNumber) {
      const rows = selectVersions.all(prNumber) as {
        head_sha: string;
        created_at: string;
      }[];
      return rows.map((r) => ({ headSha: r.head_sha, createdAt: r.created_at }));
    },

    listAllPrs() {
      // SQLite GROUP BY: head_sha is the last row in each group when rows are
      // pre-sorted by (created_at DESC, head_sha DESC) in the subquery, so
      // latest_head_sha corresponds to the latest scaffold for each PR.
      const rows = selectAllPrs.all() as {
        pr_number: number;
        versions: number;
        latest_created_at: string;
        latest_head_sha: string;
      }[];
      return rows.map((r) => ({
        prNumber: r.pr_number,
        versions: r.versions,
        latestHeadSha: r.latest_head_sha,
        latestCreatedAt: r.latest_created_at,
      }));
    },

    isStale(prNumber, currentHeadSha) {
      const row = selectLatest.get(prNumber) as ScaffoldRow | undefined;
      if (!row) return { stale: false, storedHeadSha: null };
      return {
        stale: row.head_sha !== currentHeadSha,
        storedHeadSha: row.head_sha,
      };
    },

    addLearning(text) {
      const createdAt = new Date().toISOString();
      const info = insertLearning.run(text, createdAt);
      return { id: Number(info.lastInsertRowid), text, createdAt };
    },

    listLearnings() {
      const rows = selectLearnings.all() as LearningRow[];
      return rows.map((r) => ({
        id: r.id,
        text: r.text,
        createdAt: r.created_at,
      }));
    },

    seedFindingThreads(scaffold) {
      seedFindingThreadsTx(scaffold);
    },

    listThreads(prNumber, headSha) {
      const rows = selectThreadsForPr.all(prNumber, headSha) as ThreadRow[];
      return rows.map((row) => threadFromRow(prNumber, headSha, row));
    },

    getThread(prNumber, headSha, threadId) {
      const row = selectThreadByKey.get(prNumber, headSha, threadId) as
        | ThreadRow
        | undefined;
      return row ? threadFromRow(prNumber, headSha, row) : null;
    },

    createThread(prNumber, headSha, anchor, comment) {
      const threadId = `t-${randomUUID()}`;
      const create = db.transaction((): Thread => {
        insertThread.run(
          prNumber,
          headSha,
          threadId,
          JSON.stringify(anchor),
          "open",
          new Date().toISOString(),
        );
        const opening = writeComment(
          prNumber,
          headSha,
          `c-${randomUUID()}`,
          threadId,
          comment,
        );
        return { id: threadId, anchor, status: "open", comments: [opening] };
      });
      return create();
    },

    addComment(prNumber, headSha, threadId, comment) {
      const row = selectThreadByKey.get(prNumber, headSha, threadId) as
        | ThreadRow
        | undefined;
      if (!row) throw new Error(`no such thread: ${threadId}`);
      return writeComment(
        prNumber,
        headSha,
        `c-${randomUUID()}`,
        threadId,
        comment,
      );
    },

    setThreadStatus(prNumber, headSha, threadId, status) {
      const info = updateThreadStatus.run(status, prNumber, headSha, threadId);
      if (info.changes === 0) throw new Error(`no such thread: ${threadId}`);
    },

    setCommentVisibility(prNumber, headSha, threadId, commentId, visibility) {
      const info = updateCommentVisibility.run(
        visibility,
        prNumber,
        headSha,
        threadId,
        commentId,
      );
      if (info.changes === 0) return null;
      const row = selectCommentByKey.get(
        prNumber,
        headSha,
        threadId,
        commentId,
      ) as CommentRow | undefined;
      return row ? commentFromRow(row) : null;
    },

    editComment(prNumber, headSha, threadId, commentId, body) {
      const info = updateCommentBody.run(
        body,
        prNumber,
        headSha,
        threadId,
        commentId,
      );
      if (info.changes === 0) return null;
      const row = selectCommentByKey.get(
        prNumber,
        headSha,
        threadId,
        commentId,
      ) as CommentRow | undefined;
      return row ? commentFromRow(row) : null;
    },

    deleteComment(prNumber, headSha, threadId, commentId) {
      const remove = db.transaction(
        (): { deleted: boolean; threadDeleted: boolean } => {
          const info = deleteCommentStmt.run(
            prNumber,
            headSha,
            threadId,
            commentId,
          );
          if (info.changes === 0) return { deleted: false, threadDeleted: false };
          const { n } = countCommentsForThread.get(
            prNumber,
            headSha,
            threadId,
          ) as { n: number };
          if (n === 0) {
            deleteThreadStmt.run(prNumber, headSha, threadId);
            return { deleted: true, threadDeleted: true };
          }
          return { deleted: true, threadDeleted: false };
        },
      );
      return remove();
    },

    pendingComments(prNumber, headSha) {
      const rows = selectPendingComments.all(prNumber, headSha) as CommentRow[];
      return rows.map(commentFromRow);
    },

    submitReview(prNumber, headSha, verdict, summary) {
      const submittedAt = new Date().toISOString();
      const submit = db.transaction((): Review => {
        drainPendingComments.run(prNumber, headSha);
        upsertReview.run(prNumber, headSha, verdict, summary, submittedAt);
        return { verdict, summary, submittedAt };
      });
      return submit();
    },

    getReview(prNumber, headSha) {
      const row = selectReview.get(prNumber, headSha) as
        | { verdict: string; summary: string; submitted_at: string }
        | undefined;
      if (!row) return null;
      return {
        verdict: row.verdict as Review["verdict"],
        summary: row.summary,
        submittedAt: row.submitted_at,
      };
    },

    recordExport(prNumber, headSha, result) {
      const exportedAt = new Date().toISOString();
      const url = result.url ?? null;
      upsertExport.run(prNumber, headSha, result.githubReviewId, url, exportedAt);
      return { githubReviewId: result.githubReviewId, url, exportedAt };
    },

    getExport(prNumber, headSha) {
      const row = selectExport.get(prNumber, headSha) as
        | { github_review_id: number; url: string | null; exported_at: string }
        | undefined;
      if (!row) return null;
      return {
        githubReviewId: row.github_review_id,
        url: row.url,
        exportedAt: row.exported_at,
      };
    },

    listSavedReplies() {
      const rows = selectSavedReplies.all() as {
        id: number;
        title: string;
        body: string;
        created_at: string;
      }[];
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        createdAt: r.created_at,
      }));
    },

    createSavedReply(title, body) {
      const createdAt = new Date().toISOString();
      const info = insertSavedReply.run(title, body, createdAt);
      return { id: Number(info.lastInsertRowid), title, body, createdAt };
    },

    deleteSavedReply(id) {
      return deleteSavedReplyStmt.run(id).changes > 0;
    },

    setScaffoldPartial(prNumber, headSha, partial) {
      upsertScaffoldPartial.run(prNumber, headSha, partial ? 1 : 0);
    },

    getScaffoldPartial(prNumber, headSha) {
      const row = selectScaffoldPartial.get(prNumber, headSha) as { partial: number } | undefined;
      if (!row) return null;
      return row.partial === 1;
    },

    recordRunTiming(bucket, phase, ms) {
      insertRunTiming.run(bucket, phase, ms, new Date().toISOString());
    },

    medianRunMs(bucket, phase) {
      const rows = selectRunTimings.all(bucket, phase) as { ms: number }[];
      if (rows.length < 2) return null;
      const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 0) {
        return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
      }
      return sorted[mid];
    },

    getModelChoices(prNumber) {
      const row = selectModelChoices.get(prNumber) as
        | { assistant_model: string | null; scaffolder_model: string | null }
        | undefined;
      if (!row) return null;
      return {
        assistantModel: row.assistant_model ?? null,
        scaffolderModel: row.scaffolder_model ?? null,
      };
    },

    saveModelChoices(prNumber, choices) {
      const updatedAt = new Date().toISOString();
      upsertModelChoices.run(
        prNumber,
        choices.assistantModel ?? null,
        choices.scaffolderModel ?? null,
        updatedAt,
      );
    },

    close() {
      db.close();
    },
  };

  return store;
}
