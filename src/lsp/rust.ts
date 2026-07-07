/**
 * Rust LangProvider: a thin adapter over the stdio LSP client, backed by
 * `rust-analyzer` found on PATH. Detection is a `rust-analyzer --version`
 * probe (5s timeout); absent binary → provider settles in "unavailable"
 * with an install hint, all queries returning null/[].
 *
 * rust-analyzer answers the initialize handshake quickly but keeps indexing
 * afterwards; timed-out requests mark the provider "warming" (see stdio.ts).
 */

import { createStdioProvider } from "./stdio.ts";
import type { LangProvider } from "./types.ts";

export const RUST_INSTALL_HINT = "brew install rust-analyzer";

export function createRustProvider(worktreeRoot: string): LangProvider {
  return createStdioProvider({
    command: "rust-analyzer",
    languages: ["rs"],
    languageId: "rust",
    worktreeRoot,
    installHint: RUST_INSTALL_HINT,
    source: "rust-analyzer",
  });
}
