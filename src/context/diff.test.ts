import { describe, it, expect } from "vitest";
import { parseChangedRegions } from "./diff.ts";

describe("parseChangedRegions", () => {
  it("added-only hunk yields a single RIGHT region", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,5 @@ context
 unchanged one
+added first
+added second
 unchanged two
 unchanged three
`;
    expect(parseChangedRegions(diff)).toEqual([
      { file: "src/a.ts", side: "RIGHT", startLine: 11, endLine: 12 },
    ]);
  });

  it("deleted-only hunk yields a single LEFT region", () => {
    const diff = `diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -20,4 +20,2 @@
 keep
-remove one
-remove two
 keep two
`;
    expect(parseChangedRegions(diff)).toEqual([
      { file: "src/b.ts", side: "LEFT", startLine: 21, endLine: 22 },
    ]);
  });

  it("mixed hunk yields both a LEFT and a RIGHT region", () => {
    const diff = `diff --git a/src/c.ts b/src/c.ts
--- a/src/c.ts
+++ b/src/c.ts
@@ -5,4 +5,4 @@
 ctx
-old line
+new line
+another new
 ctx tail
`;
    // old line is at old line 6; new lines are new 6 and 7.
    expect(parseChangedRegions(diff)).toEqual([
      { file: "src/c.ts", side: "RIGHT", startLine: 6, endLine: 7 },
      { file: "src/c.ts", side: "LEFT", startLine: 6, endLine: 6 },
    ]);
  });

  it("handles multiple files and multiple hunks", () => {
    const diff = `diff --git a/one.ts b/one.ts
--- a/one.ts
+++ b/one.ts
@@ -1,2 +1,3 @@
 a
+inserted
 b
@@ -10,2 +11,2 @@
-gone
+changed
 tail
diff --git a/two.ts b/two.ts
--- a/two.ts
+++ b/two.ts
@@ -1,1 +1,2 @@
 x
+y
`;
    expect(parseChangedRegions(diff)).toEqual([
      { file: "one.ts", side: "RIGHT", startLine: 2, endLine: 2 },
      { file: "one.ts", side: "RIGHT", startLine: 11, endLine: 11 },
      { file: "one.ts", side: "LEFT", startLine: 10, endLine: 10 },
      { file: "two.ts", side: "RIGHT", startLine: 2, endLine: 2 },
    ]);
  });

  it("handles a newly added file (--- /dev/null)", () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,3 @@
+line one
+line two
+line three
`;
    expect(parseChangedRegions(diff)).toEqual([
      { file: "new.ts", side: "RIGHT", startLine: 1, endLine: 3 },
    ]);
  });

  it("handles a deleted file (+++ /dev/null) keying off the LEFT path", () => {
    const diff = `diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`;
    expect(parseChangedRegions(diff)).toEqual([
      { file: "old.ts", side: "LEFT", startLine: 1, endLine: 2 },
    ]);
  });

  it("ignores context-only hunks and the no-newline marker", () => {
    const diff = `diff --git a/d.ts b/d.ts
--- a/d.ts
+++ b/d.ts
@@ -1,3 +1,3 @@
 a
 b
 c
@@ -10,1 +10,1 @@
-old
+new
\\ No newline at end of file
`;
    expect(parseChangedRegions(diff)).toEqual([
      { file: "d.ts", side: "RIGHT", startLine: 10, endLine: 10 },
      { file: "d.ts", side: "LEFT", startLine: 10, endLine: 10 },
    ]);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseChangedRegions("")).toEqual([]);
  });
});
