/**
 * Java LangProvider: a thin adapter over the stdio LSP client, backed by
 * `jdtls` (Eclipse JDT language server wrapper) found on PATH. Detection is
 * a `jdtls --version` probe (5s timeout); absent binary → provider settles
 * in "unavailable" with an install hint, all queries returning null/[].
 *
 * jdtls wants a workspace data directory; we point it at a session-scoped
 * temp dir so it never writes metadata into the worktree.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStdioProvider } from "./stdio.ts";
import type { LangProvider } from "./types.ts";

export const JAVA_INSTALL_HINT = "brew install jdtls";

export function createJavaProvider(worktreeRoot: string): LangProvider {
  return createStdioProvider({
    command: "jdtls",
    args: ["-data", join(tmpdir(), `sleek-jdtls-${process.pid}`)],
    languages: ["java"],
    languageId: "java",
    worktreeRoot,
    installHint: JAVA_INSTALL_HINT,
    source: "jdtls",
  });
}
