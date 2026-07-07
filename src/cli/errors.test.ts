import { describe, expect, it } from "vitest";
import { friendlyIngestError, friendlyMissingReviewError, formatFriendlyError } from "./errors.ts";
import type { IngestErrorKind } from "../ingest/ingest.ts";

describe("friendlyIngestError", () => {
  const kinds: IngestErrorKind[] = [
    "gh-not-installed",
    "gh-not-authenticated",
    "repo-not-found",
    "pr-not-found",
    "gh-failed",
    "bad-output",
  ];

  for (const kind of kinds) {
    it(`${kind}: headline is non-empty and exits 1 or 2`, () => {
      const err = friendlyIngestError(kind);
      expect(err.headline.length).toBeGreaterThan(0);
      expect(err.detail.length).toBeGreaterThan(0);
      expect([1, 2]).toContain(err.exitCode);
    });
  }

  it("gh-not-installed includes brew install gh", () => {
    const err = friendlyIngestError("gh-not-installed");
    expect(err.detail).toContain("brew install gh");
  });

  it("gh-not-authenticated includes gh auth login", () => {
    const err = friendlyIngestError("gh-not-authenticated");
    expect(err.detail).toContain("gh auth login");
  });

  it("pr-not-found includes PR number in headline", () => {
    const err = friendlyIngestError("pr-not-found", { prNumber: 42 });
    expect(err.headline).toContain("42");
  });

  it("repo-not-found includes repo path", () => {
    const err = friendlyIngestError("repo-not-found", { repoPath: "/my/repo" });
    expect(err.headline).toContain("/my/repo");
  });

  it("bad-output exits 2", () => {
    const err = friendlyIngestError("bad-output");
    expect(err.exitCode).toBe(2);
  });
});

describe("friendlyMissingReviewError", () => {
  it("mentions the PR number and dump-regions command", () => {
    const err = friendlyMissingReviewError(123, "/path/to/repo");
    expect(err.headline).toContain("123");
    expect(err.detail).toContain("dump-regions");
    expect(err.detail).toContain("scripts/reviews/123.json");
    expect(err.exitCode).toBe(1);
  });
});

describe("formatFriendlyError", () => {
  it("starts with Error:", () => {
    const err = friendlyIngestError("gh-not-installed");
    const formatted = formatFriendlyError(err);
    expect(formatted).toMatch(/^Error:/);
    expect(formatted).toContain(err.headline);
    expect(formatted).toContain(err.detail);
  });
});
