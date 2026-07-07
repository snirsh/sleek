import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRustProvider, RUST_INSTALL_HINT } from "./rust.ts";
import { createJavaProvider, JAVA_INSTALL_HINT } from "./java.ts";
import type { LangProvider } from "./types.ts";

/**
 * The absent-binary path: PATH points at an empty dir, so rust-analyzer and
 * jdtls cannot be found. Providers must settle in "unavailable" with their
 * install hint and answer null/[] instead of throwing.
 */
describe("rust/java adapters with no binary on PATH", () => {
  let emptyDir: string;
  let savedPath: string | undefined;

  beforeAll(async () => {
    emptyDir = await mkdtemp(join(tmpdir(), "sleek-empty-path-"));
    savedPath = process.env.PATH;
    process.env.PATH = emptyDir;
  });

  afterAll(async () => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(emptyDir, { recursive: true, force: true });
  });

  async function expectUnavailable(
    provider: LangProvider,
    ext: string,
    hint: string,
  ): Promise<void> {
    expect(provider.state()).toBe("off"); // lazy — nothing probed yet
    expect(await provider.detect()).toBe(false);
    await provider.ready();
    expect(provider.state()).toBe("unavailable");
    expect(provider.installHint).toBe(hint);
    expect(provider.languages).toContain(ext);
    expect(await provider.hover(`x.${ext}`, 1, 1)).toBeNull();
    expect(await provider.definition(`x.${ext}`, 1, 1)).toEqual([]);
    expect(await provider.diagnostics(`x.${ext}`)).toEqual([]);
    await provider.dispose();
  }

  it("rust-analyzer absent → unavailable with install hint", async () => {
    await expectUnavailable(
      createRustProvider(emptyDir),
      "rs",
      RUST_INSTALL_HINT,
    );
  });

  it("jdtls absent → unavailable with install hint", async () => {
    await expectUnavailable(
      createJavaProvider(emptyDir),
      "java",
      JAVA_INSTALL_HINT,
    );
  });
});
