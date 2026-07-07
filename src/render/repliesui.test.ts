import { describe, expect, it } from "vitest";

import { insertSnippet } from "./repliesui.ts";

describe("insertSnippet", () => {
  it("inserts at a collapsed caret", () => {
    expect(insertSnippet("hello world", 6, 6, "big ")).toEqual({
      value: "hello big world",
      caret: 10,
    });
  });

  it("replaces the selected range", () => {
    expect(insertSnippet("hello world", 6, 11, "there")).toEqual({
      value: "hello there",
      caret: 11,
    });
  });

  it("inserts into an empty value", () => {
    expect(insertSnippet("", 0, 0, "LGTM")).toEqual({ value: "LGTM", caret: 4 });
  });

  it("appends when the bounds are out of range or non-numeric", () => {
    expect(insertSnippet("abc", 99, 99, "!")).toEqual({ value: "abc!", caret: 4 });
    expect(insertSnippet("abc", -1, 2, "!")).toEqual({ value: "abc!", caret: 4 });
    expect(insertSnippet("abc", Number.NaN, Number.NaN, "!")).toEqual({
      value: "abc!",
      caret: 4,
    });
  });

  it("treats a reversed range as a caret at start", () => {
    expect(insertSnippet("abcdef", 4, 2, "-")).toEqual({ value: "abcd-ef", caret: 5 });
  });

  it("caret lands after the snippet at position 0", () => {
    expect(insertSnippet("body", 0, 0, "> ")).toEqual({ value: "> body", caret: 2 });
  });
});
