import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { ReviewScaffold } from "../domain/scaffold.ts";
import { openStore, type Store } from "./store.ts";

/** Temp dirs created by file-backed tests, cleaned up after each test. */
const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** Build a minimal, schema-valid ReviewScaffold for a given PR number + head SHA. */
function makeScaffold(
  prNumber: number,
  headSha: string,
  overrides: { title?: string } = {},
): ReviewScaffold {
  return {
    pr: {
      number: prNumber,
      title: overrides.title ?? `PR #${prNumber}`,
      description: "A test PR.",
      baseSha: "base0000000000000000000000000000000000000",
      headSha,
    },
    layers: [
      {
        id: "layer-1",
        anchors: [
          { file: "src/a.ts", side: "RIGHT", startLine: 1, endLine: 10 },
        ],
        order: 0,
        bundle: {
          summary: "Adds a thing.",
          neighbors: [],
          history: [],
          learnings: [],
        },
        findings: [
          {
            anchor: {
              file: "src/a.ts",
              side: "RIGHT",
              startLine: 3,
              endLine: 3,
            },
            concern: "correctness",
            severity: "minor",
            text: "Consider a guard clause.",
          },
        ],
      },
    ],
  };
}

/** Fresh in-memory store per test; closed by the returned disposer. */
function freshStore(): Store {
  return openStore(":memory:");
}

describe("openStore", () => {
  it("saves and gets a scaffold, round-tripped through parseReviewScaffold", () => {
    const store = freshStore();
    const scaffold = makeScaffold(42, "headAAAA");

    store.saveScaffold(scaffold);
    const got = store.getScaffold(42, "headAAAA");

    expect(got).toEqual(scaffold);
    store.close();
  });

  it("returns null for a scaffold that was never saved", () => {
    const store = freshStore();
    expect(store.getScaffold(42, "nope")).toBeNull();
    expect(store.getLatestForPr(42)).toBeNull();
    store.close();
  });

  it("throws clearly when a stored row is corrupt (parse guard)", () => {
    // Use a real file so we can tamper with the row via a separate raw connection,
    // then reopen through the store and confirm getScaffold surfaces the bad shape.
    const dir = mkdtempSync(join(tmpdir(), "sleek-store-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "corrupt.db");

    const store = openStore(dbPath);
    store.saveScaffold(makeScaffold(7, "headX"));
    store.close();

    // Overwrite the JSON blob with a structurally-invalid scaffold (missing `layers`).
    const raw = new Database(dbPath);
    raw
      .prepare(`UPDATE scaffolds SET scaffold = ? WHERE pr_number = ? AND head_sha = ?`)
      .run(JSON.stringify({ pr: { number: 7 } }), 7, "headX");
    raw.close();

    const reopened = openStore(dbPath);
    expect(() => reopened.getScaffold(7, "headX")).toThrow();
    reopened.close();
  });

  it("getLatestForPr picks the newest scaffold across head SHAs", async () => {
    const store = freshStore();

    store.saveScaffold(makeScaffold(100, "oldSha", { title: "old" }));
    // Ensure a distinct, later createdAt timestamp.
    await new Promise((r) => setTimeout(r, 5));
    store.saveScaffold(makeScaffold(100, "newSha", { title: "new" }));

    const latest = store.getLatestForPr(100);
    expect(latest).not.toBeNull();
    expect(latest!.headSha).toBe("newSha");
    expect(latest!.scaffold.pr.title).toBe("new");
    expect(typeof latest!.createdAt).toBe("string");
    store.close();
  });

  it("isStale reports not-stale with null SHA when no scaffold exists", () => {
    const store = freshStore();
    expect(store.isStale(1, "anySha")).toEqual({
      stale: false,
      storedHeadSha: null,
    });
    store.close();
  });

  it("isStale reports not-stale when the latest stored SHA matches", () => {
    const store = freshStore();
    store.saveScaffold(makeScaffold(1, "matchSha"));
    expect(store.isStale(1, "matchSha")).toEqual({
      stale: false,
      storedHeadSha: "matchSha",
    });
    store.close();
  });

  it("isStale reports stale when the latest stored SHA differs", () => {
    const store = freshStore();
    store.saveScaffold(makeScaffold(1, "storedSha"));
    expect(store.isStale(1, "currentSha")).toEqual({
      stale: true,
      storedHeadSha: "storedSha",
    });
    store.close();
  });

  it("listScaffoldVersions returns [] for a PR with no scaffolds", () => {
    const store = freshStore();
    expect(store.listScaffoldVersions(999)).toEqual([]);
    store.close();
  });

  it("listScaffoldVersions lists key columns newest-first, scoped to the PR", async () => {
    const store = freshStore();
    store.saveScaffold(makeScaffold(9, "shaOld"));
    await new Promise((r) => setTimeout(r, 5));
    store.saveScaffold(makeScaffold(9, "shaNew"));
    store.saveScaffold(makeScaffold(10, "otherPr"));

    const versions = store.listScaffoldVersions(9);
    expect(versions.map((v) => v.headSha)).toEqual(["shaNew", "shaOld"]);
    for (const v of versions) expect(typeof v.createdAt).toBe("string");
    // Newest-first mirrors getLatestForPr's notion of "most recent".
    expect(versions[0]!.headSha).toBe(store.getLatestForPr(9)!.headSha);
    store.close();
  });

  it("listScaffoldVersions keeps one entry per (pr, headSha) across re-saves (upsert)", () => {
    const store = freshStore();
    store.saveScaffold(makeScaffold(11, "sameSha"));
    store.saveScaffold(makeScaffold(11, "sameSha"));
    expect(store.listScaffoldVersions(11)).toHaveLength(1);
    store.close();
  });

  it("listAllPrs returns [] when no scaffolds exist", () => {
    const store = freshStore();
    expect(store.listAllPrs()).toEqual([]);
    store.close();
  });

  it("listAllPrs returns one row per PR with correct version count", async () => {
    const store = freshStore();
    store.saveScaffold(makeScaffold(20, "sha20a"));
    await new Promise((r) => setTimeout(r, 5));
    store.saveScaffold(makeScaffold(20, "sha20b"));
    store.saveScaffold(makeScaffold(21, "sha21a"));

    const prs = store.listAllPrs();
    expect(prs.map((p) => p.prNumber).sort()).toEqual([20, 21].sort());

    const pr20 = prs.find((p) => p.prNumber === 20)!;
    const pr21 = prs.find((p) => p.prNumber === 21)!;
    expect(pr20.versions).toBe(2);
    expect(pr21.versions).toBe(1);
    // latestHeadSha must be the newest scaffold for each PR
    expect(pr20.latestHeadSha).toBe("sha20b");
    expect(pr21.latestHeadSha).toBe("sha21a");
    store.close();
  });

  it("listAllPrs orders by latestCreatedAt descending", async () => {
    const store = freshStore();
    store.saveScaffold(makeScaffold(30, "sha30"));
    await new Promise((r) => setTimeout(r, 5));
    store.saveScaffold(makeScaffold(31, "sha31"));

    const prs = store.listAllPrs();
    expect(prs[0]!.prNumber).toBe(31); // newer
    expect(prs[1]!.prNumber).toBe(30);
    store.close();
  });

  it("listAllPrs never loads scaffold JSON blobs (verified via struct shape)", () => {
    const store = freshStore();
    store.saveScaffold(makeScaffold(40, "sha40"));
    const prs = store.listAllPrs();
    // PrSummary has no 'scaffold' field — just key columns
    const row = prs[0]!;
    expect(Object.keys(row).sort()).toEqual(
      ["prNumber", "versions", "latestHeadSha", "latestCreatedAt"].sort(),
    );
    store.close();
  });

  it("upsert replaces rather than duplicating on the same (pr, headSha)", () => {
    const store = freshStore();

    store.saveScaffold(makeScaffold(5, "sameSha", { title: "first" }));
    store.saveScaffold(makeScaffold(5, "sameSha", { title: "second" }));

    // getScaffold reflects the replacement...
    expect(store.getScaffold(5, "sameSha")!.pr.title).toBe("second");
    // ...and getLatestForPr still resolves to the single (replaced) row.
    const latest = store.getLatestForPr(5);
    expect(latest!.headSha).toBe("sameSha");
    expect(latest!.scaffold.pr.title).toBe("second");
    store.close();
  });
});

/**
 * A scaffold with `findingsPerLayer[i]` findings in layer i — enough structure
 * to produce the positional `f-<layerIdx>-<k>` thread ids that collide across PRs.
 */
function makeScaffoldWithFindings(
  prNumber: number,
  headSha: string,
  findingsPerLayer: number[],
): ReviewScaffold {
  return {
    pr: {
      number: prNumber,
      title: `PR #${prNumber}`,
      description: "A test PR.",
      baseSha: "base0000000000000000000000000000000000000",
      headSha,
    },
    layers: findingsPerLayer.map((count, li) => ({
      id: `layer-${li}`,
      anchors: [
        { file: `src/f${li}.ts`, side: "RIGHT" as const, startLine: 1, endLine: 50 },
      ],
      order: li,
      bundle: { summary: `Layer ${li}.`, neighbors: [], history: [], learnings: [] },
      findings: Array.from({ length: count }, (_, k) => ({
        anchor: {
          file: `src/f${li}.ts`,
          side: "RIGHT" as const,
          startLine: k + 1,
          endLine: k + 1,
        },
        concern: "correctness" as const,
        severity: "minor" as const,
        text: `PR ${prNumber} layer ${li} finding ${k}`,
      })),
    })),
  };
}

/** All thread ids for (pr, sha), in listThreads order. */
function threadIds(store: Store, pr: number, sha: string): string[] {
  return store.listThreads(pr, sha).map((t) => t.id);
}

describe("threads across PRs (composite (pr, sha, id) key)", () => {
  const SHA_A = "shaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const SHA_B = "shaBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  it("fully seeds a second PR whose positional thread ids collide with the first's", () => {
    const store = freshStore();
    // PR 1: 2+1 findings → f-0-0, f-0-1, f-1-0.
    store.seedFindingThreads(makeScaffoldWithFindings(101, SHA_A, [2, 1]));
    // PR 2: 2+2+1 findings → f-0-0 … f-2-0; f-0-0/f-0-1/f-1-0 collide with PR 1.
    store.seedFindingThreads(makeScaffoldWithFindings(202, SHA_B, [2, 2, 1]));

    expect(threadIds(store, 101, SHA_A)).toEqual(["f-0-0", "f-0-1", "f-1-0"]);
    expect(threadIds(store, 202, SHA_B)).toEqual([
      "f-0-0",
      "f-0-1",
      "f-1-0",
      "f-1-1",
      "f-2-0",
    ]);

    // Each seeded thread carries ITS OWN PR's opening finding comment.
    const pr1 = store.getThread(101, SHA_A, "f-0-0")!;
    const pr2 = store.getThread(202, SHA_B, "f-0-0")!;
    expect(pr1.comments).toHaveLength(1);
    expect(pr1.comments[0]!.body).toBe("PR 101 layer 0 finding 0");
    expect(pr2.comments[0]!.body).toBe("PR 202 layer 0 finding 0");
    store.close();
  });

  it("re-seeding the same (pr, sha) stays a no-op", () => {
    const store = freshStore();
    const scaffold = makeScaffoldWithFindings(101, SHA_A, [2]);
    store.seedFindingThreads(scaffold);
    store.seedFindingThreads(scaffold);

    expect(threadIds(store, 101, SHA_A)).toEqual(["f-0-0", "f-0-1"]);
    // No duplicated opening comments either.
    for (const t of store.listThreads(101, SHA_A)) {
      expect(t.comments).toHaveLength(1);
    }
    store.close();
  });

  it("scopes getThread/addComment/setThreadStatus to the (pr, sha) key", () => {
    const store = freshStore();
    store.seedFindingThreads(makeScaffoldWithFindings(101, SHA_A, [1]));
    store.seedFindingThreads(makeScaffoldWithFindings(202, SHA_B, [1]));

    // Mutate PR 202's f-0-0 only.
    store.addComment(202, SHA_B, "f-0-0", {
      author: { type: "reviewer" },
      body: "only on PR 202",
      pending: true,
    });
    store.setThreadStatus(202, SHA_B, "f-0-0", "resolved");

    expect(store.getThread(202, SHA_B, "f-0-0")!.status).toBe("resolved");
    expect(store.getThread(202, SHA_B, "f-0-0")!.comments).toHaveLength(2);
    // PR 101's same-id thread is untouched.
    expect(store.getThread(101, SHA_A, "f-0-0")!.status).toBe("open");
    expect(store.getThread(101, SHA_A, "f-0-0")!.comments).toHaveLength(1);
    // Lookups miss when the scope doesn't match.
    expect(store.getThread(101, SHA_B, "f-0-0")).toBeNull();
    expect(() =>
      store.setThreadStatus(999, SHA_A, "f-0-0", "resolved"),
    ).toThrow(/no such thread/);
    expect(() =>
      store.addComment(999, SHA_A, "f-0-0", {
        author: { type: "reviewer" },
        body: "nope",
        pending: true,
      }),
    ).toThrow(/no such thread/);
    store.close();
  });

  it("isolates pendingComments and submitReview per (pr, sha)", () => {
    const store = freshStore();
    store.seedFindingThreads(makeScaffoldWithFindings(101, SHA_A, [1]));
    store.seedFindingThreads(makeScaffoldWithFindings(202, SHA_B, [1]));
    store.addComment(101, SHA_A, "f-0-0", {
      author: { type: "reviewer" },
      body: "pending on PR 101",
      pending: true,
    });
    store.addComment(202, SHA_B, "f-0-0", {
      author: { type: "reviewer" },
      body: "pending on PR 202",
      pending: true,
    });

    expect(store.pendingComments(101, SHA_A).map((c) => c.body)).toEqual([
      "pending on PR 101",
    ]);
    expect(store.pendingComments(202, SHA_B).map((c) => c.body)).toEqual([
      "pending on PR 202",
    ]);

    // Submitting PR 101's review drains ONLY its pending comments.
    store.submitReview(101, SHA_A, "approve", "LGTM");
    expect(store.pendingComments(101, SHA_A)).toEqual([]);
    expect(store.pendingComments(202, SHA_B)).toHaveLength(1);
    expect(store.getReview(101, SHA_A)!.verdict).toBe("approve");
    expect(store.getReview(202, SHA_B)).toBeNull();
    store.close();
  });
});

describe("legacy thread-schema migration", () => {
  const SHA_A = "shaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const SHA_B = "shaBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  /** Build a db in the PRE-composite-key shape and return its path. */
  function buildLegacyDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "sleek-store-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "legacy.db");
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE threads (
        id         TEXT    PRIMARY KEY,
        pr_number  INTEGER NOT NULL,
        head_sha   TEXT    NOT NULL,
        anchor     TEXT    NOT NULL,
        status     TEXT    NOT NULL,
        created_at TEXT    NOT NULL
      );
      CREATE INDEX idx_threads_pr_sha ON threads (pr_number, head_sha);
      CREATE TABLE comments (
        id         TEXT    NOT NULL PRIMARY KEY,
        thread_id  TEXT    NOT NULL REFERENCES threads(id),
        author     TEXT    NOT NULL,
        body       TEXT    NOT NULL,
        pending    INTEGER NOT NULL,
        concern    TEXT,
        severity   TEXT,
        created_at TEXT    NOT NULL
      );
      CREATE INDEX idx_comments_thread ON comments (thread_id);
    `);
    const anchor = JSON.stringify({
      file: "src/a.ts",
      side: "RIGHT",
      startLine: 1,
      endLine: 3,
    });
    const insThread = raw.prepare(
      `INSERT INTO threads (id, pr_number, head_sha, anchor, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insComment = raw.prepare(
      `INSERT INTO comments (id, thread_id, author, body, pending, concern, severity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const t0 = "2026-01-01T00:00:00.000Z";
    // A seeded finding thread + a reviewer thread, as a real legacy db holds.
    insThread.run("f-0-0", 101, SHA_A, anchor, "open", t0);
    insComment.run("f-0-0-c0", "f-0-0", '{"type":"finding"}', "finding text", 0, "correctness", "minor", t0);
    insThread.run("t-1111", 101, SHA_A, anchor, "resolved", t0);
    insComment.run("c-1111", "t-1111", '{"type":"reviewer"}', "reviewer question", 0, null, null, t0);
    insComment.run("c-2222", "t-1111", '{"type":"reviewer"}', "reviewer follow-up", 1, null, null, t0);
    raw.close();
    return dbPath;
  }

  it("migrates legacy rows into the composite schema without losing comments", () => {
    const dbPath = buildLegacyDb();
    const store = openStore(dbPath);

    const threads = store.listThreads(101, SHA_A);
    expect(threads.map((t) => t.id)).toEqual(["f-0-0", "t-1111"]);
    expect(threads[0]!.comments.map((c) => c.body)).toEqual(["finding text"]);
    expect(threads[0]!.comments[0]!.concern).toBe("correctness");
    expect(threads[1]!.status).toBe("resolved");
    expect(threads[1]!.comments.map((c) => c.body)).toEqual([
      "reviewer question",
      "reviewer follow-up",
    ]);
    // Pending flags survive the copy.
    expect(store.pendingComments(101, SHA_A).map((c) => c.body)).toEqual([
      "reviewer follow-up",
    ]);
    store.close();

    // The tables are now composite-keyed: pr_number is part of both PKs.
    const raw = new Database(dbPath, { readonly: true });
    for (const table of ["threads", "comments"]) {
      const cols = raw.pragma(`table_info(${table})`) as {
        name: string;
        pk: number;
      }[];
      expect(cols.find((c) => c.name === "pr_number")!.pk).toBe(1);
      expect(cols.find((c) => c.name === "id")!.pk).toBe(3);
    }
    raw.close();
  });

  it("seeds a colliding second PR fully after migrating", () => {
    const store = openStore(buildLegacyDb());
    // f-0-0 collides with the migrated PR 101 thread; both must exist afterwards.
    store.seedFindingThreads(makeScaffoldWithFindings(202, SHA_B, [2]));

    expect(threadIds(store, 202, SHA_B)).toEqual(["f-0-0", "f-0-1"]);
    expect(store.getThread(202, SHA_B, "f-0-0")!.comments[0]!.body).toBe(
      "PR 202 layer 0 finding 0",
    );
    // The migrated PR is intact.
    expect(threadIds(store, 101, SHA_A)).toEqual(["f-0-0", "t-1111"]);
    expect(store.getThread(101, SHA_A, "f-0-0")!.comments[0]!.body).toBe(
      "finding text",
    );
    store.close();
  });

  it("reopening an already-migrated db is a no-op", () => {
    const dbPath = buildLegacyDb();
    openStore(dbPath).close();
    const store = openStore(dbPath); // second open: must not re-migrate or throw
    expect(threadIds(store, 101, SHA_A)).toEqual(["f-0-0", "t-1111"]);
    expect(store.getThread(101, SHA_A, "t-1111")!.comments).toHaveLength(2);
    store.close();
  });
});

describe("comment visibility", () => {
  const SHA = "shaCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
  const anchor = {
    file: "src/a.ts",
    side: "RIGHT" as const,
    startLine: 3,
    endLine: 3,
  };

  it("adds the nullable visibility column to an old composite-schema comments table", () => {
    const dir = mkdtempSync(join(tmpdir(), "sleek-store-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "old-comments.db");
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE threads (
        pr_number  INTEGER NOT NULL,
        head_sha   TEXT    NOT NULL,
        id         TEXT    NOT NULL,
        anchor     TEXT    NOT NULL,
        status     TEXT    NOT NULL,
        created_at TEXT    NOT NULL,
        PRIMARY KEY (pr_number, head_sha, id)
      );
      CREATE TABLE comments (
        pr_number  INTEGER NOT NULL,
        head_sha   TEXT    NOT NULL,
        id         TEXT    NOT NULL,
        thread_id  TEXT    NOT NULL,
        author     TEXT    NOT NULL,
        body       TEXT    NOT NULL,
        pending    INTEGER NOT NULL,
        concern    TEXT,
        severity   TEXT,
        created_at TEXT    NOT NULL,
        PRIMARY KEY (pr_number, head_sha, id)
      );
    `);
    raw.close();

    openStore(dbPath).close();

    const reopened = new Database(dbPath, { readonly: true });
    const cols = reopened.pragma("table_info(comments)") as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("visibility");
    reopened.close();
  });

  it("round-trips omitted, local, and publishable visibility values", () => {
    const store = freshStore();
    const omitted = store.createThread(1, SHA, anchor, {
      author: { type: "reviewer" },
      body: "default publishable",
      pending: true,
    });
    const local = store.addComment(1, SHA, omitted.id, {
      author: { type: "reviewer" },
      body: "local note",
      pending: true,
      visibility: "local",
    });
    const publishable = store.addComment(1, SHA, omitted.id, {
      author: { type: "reviewer" },
      body: "explicit publishable",
      pending: true,
      visibility: "publishable",
    });

    const comments = store.getThread(1, SHA, omitted.id)!.comments;
    expect(comments[0]).not.toHaveProperty("visibility");
    expect(comments.find((c) => c.id === local.id)!.visibility).toBe("local");
    expect(comments.find((c) => c.id === publishable.id)!.visibility).toBe(
      "publishable",
    );
    expect(store.pendingComments(1, SHA).map((c) => c.visibility)).toEqual([
      undefined,
      "local",
      "publishable",
    ]);
    store.close();
  });

  it("setCommentVisibility updates a comment and returns null for a missing comment", () => {
    const store = freshStore();
    const thread = store.createThread(1, SHA, anchor, {
      author: { type: "reviewer" },
      body: "comment",
      pending: true,
    });
    const commentId = thread.comments[0]!.id;

    const updated = store.setCommentVisibility(
      1,
      SHA,
      thread.id,
      commentId,
      "local",
    );
    expect(updated).toMatchObject({ id: commentId, visibility: "local" });
    expect(store.getThread(1, SHA, thread.id)!.comments[0]!.visibility).toBe(
      "local",
    );
    expect(
      store.setCommentVisibility(1, SHA, thread.id, "missing", "publishable"),
    ).toBeNull();
    store.close();
  });
});

describe("learnings (deferred placeholder)", () => {
  it("adds and lists learnings newest-first", () => {
    const store = freshStore();
    const a = store.addLearning("prefer early returns");
    const b = store.addLearning("name booleans as predicates");

    expect(a.id).toBeGreaterThan(0);
    const all = store.listLearnings();
    expect(all.map((l) => l.text)).toContain("prefer early returns");
    expect(all.map((l) => l.text)).toContain("name booleans as predicates");
    expect(all).toHaveLength(2);
    expect(b.id).not.toBe(a.id);
    store.close();
  });
});

describe("review exports (Wave 4A)", () => {
  it("records and reads back an export, scoped by (pr, sha)", () => {
    const store = freshStore();
    const rec = store.recordExport(101, "shaA", {
      githubReviewId: 987654,
      url: "https://github.com/o/r/pull/101#pullrequestreview-987654",
    });

    expect(rec.githubReviewId).toBe(987654);
    expect(rec.url).toContain("pullrequestreview-987654");
    expect(rec.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(store.getExport(101, "shaA")).toEqual(rec);
    expect(store.getExport(101, "shaB")).toBeNull();
    expect(store.getExport(202, "shaA")).toBeNull();
    store.close();
  });

  it("defaults a missing url to null", () => {
    const store = freshStore();
    store.recordExport(1, "s", { githubReviewId: 1 });
    expect(store.getExport(1, "s")!.url).toBeNull();
    store.close();
  });

  it("upserts on re-record (a re-post replaces the record)", () => {
    const store = freshStore();
    store.recordExport(1, "s", { githubReviewId: 1, url: "u1" });
    store.recordExport(1, "s", { githubReviewId: 2, url: "u2" });
    expect(store.getExport(1, "s")).toMatchObject({ githubReviewId: 2, url: "u2" });
    store.close();
  });

  it("survives close + reopen (additive CREATE TABLE IF NOT EXISTS migration)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sleek-store-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "exports.db");

    const store = openStore(dbPath);
    store.recordExport(9, "head", { githubReviewId: 5, url: null });
    store.close();

    const reopened = openStore(dbPath);
    expect(reopened.getExport(9, "head")).toMatchObject({ githubReviewId: 5 });
    reopened.close();
  });
});

describe("saved replies (Wave 4C)", () => {
  it("creates and lists replies in creation order (global — no PR scope)", () => {
    const store = freshStore();
    const a = store.createSavedReply("Nit", "Nit: consider renaming this.");
    const b = store.createSavedReply("LGTM", "Looks good to me!");

    expect(a.id).not.toBe(b.id);
    expect(a.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(store.listSavedReplies()).toEqual([a, b]);
    store.close();
  });

  it("deletes a reply and reports whether a row existed", () => {
    const store = freshStore();
    const a = store.createSavedReply("One", "body one");
    const b = store.createSavedReply("Two", "body two");

    expect(store.deleteSavedReply(a.id)).toBe(true);
    expect(store.listSavedReplies()).toEqual([b]);
    expect(store.deleteSavedReply(a.id)).toBe(false); // already gone
    expect(store.deleteSavedReply(999)).toBe(false); // never existed
    store.close();
  });

  it("survives close + reopen (additive CREATE TABLE IF NOT EXISTS migration)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sleek-store-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "replies.db");

    const store = openStore(dbPath);
    const rec = store.createSavedReply("Persisted", "still here");
    store.close();

    const reopened = openStore(dbPath);
    expect(reopened.listSavedReplies()).toEqual([rec]);
    reopened.close();
  });
});

// ── Wave 7: model_choices + empty scaffold guard ──────────────────────────────

describe("model_choices", () => {
  it("getModelChoices returns null when no row exists", () => {
    const store = freshStore();
    expect(store.getModelChoices(99)).toBeNull();
    store.close();
  });

  it("saveModelChoices upserts and getModelChoices returns it", () => {
    const store = freshStore();
    store.saveModelChoices(1, { assistantModel: "qwen3:latest", scaffolderModel: "replay" });
    const result = store.getModelChoices(1);
    expect(result).toEqual({ assistantModel: "qwen3:latest", scaffolderModel: "replay" });
    store.close();
  });

  it("saveModelChoices is a partial upsert — omitting a field preserves the old value", () => {
    const store = freshStore();
    store.saveModelChoices(1, { assistantModel: "qwen3:latest" });
    store.saveModelChoices(1, { scaffolderModel: "replay" });
    const result = store.getModelChoices(1);
    expect(result).toEqual({ assistantModel: "qwen3:latest", scaffolderModel: "replay" });
    store.close();
  });

  it("saveModelChoices partial upsert — updating one field leaves the other intact", () => {
    const store = freshStore();
    store.saveModelChoices(5, { assistantModel: "qwen3:8b", scaffolderModel: "claude-sonnet-4-6" });
    store.saveModelChoices(5, { assistantModel: "qwen3:latest" });
    const result = store.getModelChoices(5);
    expect(result).toEqual({ assistantModel: "qwen3:latest", scaffolderModel: "claude-sonnet-4-6" });
    store.close();
  });

  it("model_choices table survives close + reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "sleek-store-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "choices.db");

    const store = openStore(dbPath);
    store.saveModelChoices(42, { assistantModel: "qwen3:30b", scaffolderModel: "replay" });
    store.close();

    const reopened = openStore(dbPath);
    expect(reopened.getModelChoices(42)).toEqual({
      assistantModel: "qwen3:30b",
      scaffolderModel: "replay",
    });
    reopened.close();
  });
});

describe("saveScaffold empty scaffold guard", () => {
  it("throws when layers is empty", () => {
    const store = freshStore();
    const emptyScaffold = {
      pr: {
        number: 1,
        title: "T",
        description: "",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
      layers: [],
    };
    expect(() => store.saveScaffold(emptyScaffold as Parameters<typeof store.saveScaffold>[0])).toThrow(
      /empty scaffold/,
    );
    store.close();
  });

  it("does not throw when layers is non-empty", () => {
    const store = freshStore();
    const scaffold = makeScaffold(1, "abc123");
    expect(() => store.saveScaffold(scaffold)).not.toThrow();
    store.close();
  });
});

describe("parseReviewScaffold accepts layers: []", () => {
  it("layers:[] parses without error", async () => {
    const { parseReviewScaffold } = await import("../domain/scaffold.ts");
    const result = parseReviewScaffold({
      pr: {
        number: 1,
        title: "Explore first",
        description: "",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
      layers: [],
    });
    expect(result.layers).toEqual([]);
    expect(result.pr.number).toBe(1);
  });
});
