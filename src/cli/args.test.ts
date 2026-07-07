import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.ts";

describe("parseArgs", () => {
  it("no args → bare help (main exits 1)", () => {
    expect(parseArgs([])).toMatchObject({ command: "help", bare: true });
  });

  it("--help → help (not bare)", () => {
    const r = parseArgs(["--help"]);
    expect(r).toMatchObject({ command: "help" });
    expect((r as { bare?: boolean }).bare).toBeUndefined();
  });

  it("-h → help", () => {
    expect(parseArgs(["-h"])).toMatchObject({ command: "help" });
  });

  it("review --help → per-command help topic", () => {
    expect(parseArgs(["review", "--help"])).toMatchObject({ command: "help", topic: "review" });
  });

  it("clean -h → per-command help topic", () => {
    expect(parseArgs(["clean", "-h"])).toMatchObject({ command: "help", topic: "clean" });
  });

  it("finish -h → per-command help topic", () => {
    expect(parseArgs(["finish", "-h"])).toMatchObject({ command: "help", topic: "finish" });
  });

  it("unknown command → error", () => {
    const r = parseArgs(["serve"]);
    expect(r.command).toBe("error");
  });

  describe("review <pr>", () => {
    it("parses PR number", () => {
      const r = parseArgs(["review", "123"], "/repo");
      expect(r).toMatchObject({ command: "review", pr: 123, repo: "/repo", open: false, json: false, refresh: false });
    });

    it("--repo overrides default", () => {
      const r = parseArgs(["review", "1", "--repo", "/other"], "/default");
      expect(r).toMatchObject({ command: "review", repo: "/other" });
    });

    it("--port sets port", () => {
      const r = parseArgs(["review", "1", "--port", "9000"], "/repo");
      expect(r).toMatchObject({ command: "review", port: 9000 });
    });

    it("--open sets open=true", () => {
      const r = parseArgs(["review", "1", "--open"], "/repo");
      expect(r).toMatchObject({ command: "review", open: true });
    });

    it("--json sets json=true", () => {
      const r = parseArgs(["review", "1", "--json"], "/repo");
      expect(r).toMatchObject({ command: "review", json: true });
    });

    it("--refresh sets refresh=true", () => {
      const r = parseArgs(["review", "1", "--refresh"], "/repo");
      expect(r).toMatchObject({ command: "review", refresh: true });
    });

    it("no PR arg → review-pick", () => {
      const r = parseArgs(["review"], "/repo");
      expect(r).toMatchObject({ command: "review-pick", repo: "/repo", repoExplicit: false });
    });

    it("review-pick respects --repo", () => {
      const r = parseArgs(["review", "--repo", "/other"], "/default");
      expect(r).toMatchObject({ command: "review-pick", repo: "/other", repoExplicit: true });
    });

    it("non-integer PR → error", () => {
      const r = parseArgs(["review", "abc"]);
      expect(r.command).toBe("error");
    });

    it("invalid port → error", () => {
      const r = parseArgs(["review", "1", "--port", "99999"]);
      expect(r.command).toBe("error");
    });

    it("unknown flag → error", () => {
      const r = parseArgs(["review", "1", "--unknown"]);
      expect(r.command).toBe("error");
    });

    it("extra positional → error", () => {
      const r = parseArgs(["review", "1", "extra"]);
      expect(r.command).toBe("error");
    });
  });

  describe("list", () => {
    it("parses", () => {
      const r = parseArgs(["list"], "/repo");
      expect(r).toMatchObject({ command: "list", repo: "/repo", json: false });
    });

    it("--json", () => {
      const r = parseArgs(["list", "--json"], "/repo");
      expect(r).toMatchObject({ command: "list", json: true });
    });

    it("--repo", () => {
      const r = parseArgs(["list", "--repo", "/other"], "/default");
      expect(r).toMatchObject({ command: "list", repo: "/other" });
    });
  });

  describe("connect", () => {
    it("parses repo, PR, and json flag", () => {
      const r = parseArgs(["connect", "--repo", "/repo", "--pr", "7", "--json"], "/default");
      expect(r).toMatchObject({ command: "connect", repo: "/repo", pr: 7, json: true });
    });

    it("allows omitting PR so the command can infer it", () => {
      const r = parseArgs(["connect"], "/repo");
      expect(r).toMatchObject({ command: "connect", repo: "/repo", json: false });
      expect((r as { pr?: number }).pr).toBeUndefined();
    });

    it("rejects invalid PR values", () => {
      expect(parseArgs(["connect", "--pr", "x"]).command).toBe("error");
      expect(parseArgs(["connect", "--pr", "0"]).command).toBe("error");
    });
  });

  describe("regions", () => {
    it("requires PR", () => {
      const r = parseArgs(["regions"], "/repo");
      expect(r.command).toBe("error");
    });

    it("parses PR and repo", () => {
      const r = parseArgs(["regions", "42", "--repo", "/r"], "/default");
      expect(r).toMatchObject({ command: "regions", pr: 42, repo: "/r" });
    });

    it("--json", () => {
      const r = parseArgs(["regions", "1", "--json"]);
      expect(r).toMatchObject({ command: "regions", json: true });
    });
  });

  describe("clean", () => {
    it("parses", () => {
      const r = parseArgs(["clean"], "/repo");
      expect(r).toMatchObject({ command: "clean", repo: "/repo", yes: false });
    });

    it("--yes", () => {
      const r = parseArgs(["clean", "--yes"], "/repo");
      expect(r).toMatchObject({ command: "clean", yes: true });
    });
  });

  describe("finish", () => {
    it("requires PR", () => {
      const r = parseArgs(["finish"], "/repo");
      expect(r.command).toBe("error");
    });

    it("parses PR and repo", () => {
      const r = parseArgs(["finish", "42", "--repo", "/r"], "/default");
      expect(r).toMatchObject({ command: "finish", pr: 42, repo: "/r", yes: false });
    });

    it("--yes", () => {
      const r = parseArgs(["finish", "42", "--yes"], "/repo");
      expect(r).toMatchObject({ command: "finish", pr: 42, repo: "/repo", yes: true });
    });

    it("non-integer PR → error", () => {
      const r = parseArgs(["finish", "abc"]);
      expect(r.command).toBe("error");
    });
  });
});

  describe("--process flag", () => {
    it("--process sets process=true", () => {
      const r = parseArgs(["review", "1", "--process"], "/repo");
      expect(r).toMatchObject({ command: "review", process: true });
    });

    it("process defaults to false", () => {
      const r = parseArgs(["review", "1"], "/repo");
      expect(r).toMatchObject({ command: "review", process: false });
    });
  });
