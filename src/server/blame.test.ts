import { describe, expect, it, vi } from "vitest";

import { createGitBlamer } from "./blame.ts";

describe("createGitBlamer", () => {
  it("runs git blame porcelain and parses the result", async () => {
    const raw = vi.fn(async () =>
      [
        "abcdef1234567890 10 12 1",
        "author Ada Lovelace",
        "author-mail <ada@example.com>",
        "author-time 1767225600",
        "author-tz +0000",
        "summary Add retry helper",
        "filename src/util.ts",
        "\tconst retry = true;",
      ].join("\n"),
    );
    const blame = createGitBlamer(
      "/repo",
      { baseSha: "base-sha", headSha: "head-sha" },
      { git: { raw } },
    );

    await expect(
      blame({ file: "src/util.ts", side: "RIGHT", line: 12 }),
    ).resolves.toEqual({
      sha: "abcdef1234567890",
      shortSha: "abcdef123456",
      author: "Ada Lovelace",
      authorDate: "2026-01-01T00:00:00.000Z",
      summary: "Add retry helper",
    });
    expect(raw).toHaveBeenCalledWith([
      "blame",
      "--porcelain",
      "-L",
      "12,12",
      "head-sha",
      "--",
      "src/util.ts",
    ]);
  });

  it("uses the base SHA for LEFT-side blame", async () => {
    const calls: string[][] = [];
    const raw = async (args: string[]) => {
      calls.push(args);
      return [
        "bbbbbbbbbbbb 1 1 1",
        "author Reviewer",
        "author-time 1767225600",
        "summary Delete old code",
      ].join("\n");
    };
    const blame = createGitBlamer(
      "/repo",
      { baseSha: "base-sha", headSha: "head-sha" },
      { git: { raw } },
    );

    await blame({ file: "old.ts", side: "LEFT", line: 1 });
    expect(calls[0]).toContain("base-sha");
  });

  it("rejects paths that escape the repo", async () => {
    const raw = vi.fn(async () => "");
    const blame = createGitBlamer(
      "/repo",
      { baseSha: "base-sha", headSha: "head-sha" },
      { git: { raw } },
    );

    await expect(
      blame({ file: "../secret.ts", side: "RIGHT", line: 1 }),
    ).resolves.toBeNull();
    await expect(
      blame({ file: "src/../../secret.ts", side: "RIGHT", line: 1 }),
    ).resolves.toBeNull();
    expect(raw).not.toHaveBeenCalled();
  });

  it("returns null on git errors", async () => {
    const blame = createGitBlamer(
      "/repo",
      { baseSha: "base-sha", headSha: "head-sha" },
      { git: { raw: async () => { throw new Error("bad revision"); } } },
    );

    await expect(
      blame({ file: "src/util.ts", side: "RIGHT", line: 1 }),
    ).resolves.toBeNull();
  });
});
