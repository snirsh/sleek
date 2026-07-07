import { afterEach, describe, expect, it, vi } from "vitest";

import { routeConsoleLogToStderr, writeJsonOutput } from "./review.ts";

let stdout = "";
let stderr = "";

function writeSpy(stream: NodeJS.WriteStream, sink: (chunk: string) => void) {
  return vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => {
    sink(String(chunk));
    return true;
  });
}

describe("review JSON output routing", () => {
  const originalLog = console.log;

  afterEach(() => {
    console.log = originalLog;
    vi.restoreAllMocks();
    stdout = "";
    stderr = "";
  });

  it("routes console.log to stderr after review output setup", () => {
    writeSpy(process.stdout, (chunk) => { stdout += chunk; });
    writeSpy(process.stderr, (chunk) => { stderr += chunk; });

    routeConsoleLogToStderr();
    console.log("progress", 123);

    expect(stdout).toBe("");
    expect(stderr).toBe("progress 123\n");
  });

  it("writes the final JSON payload to stdout only", () => {
    writeSpy(process.stdout, (chunk) => { stdout += chunk; });
    writeSpy(process.stderr, (chunk) => { stderr += chunk; });

    writeJsonOutput({ pr: 7, url: "http://localhost:63003" });

    expect(stdout).toBe('{"pr":7,"url":"http://localhost:63003"}\n');
    expect(stderr).toBe("");
  });
});
