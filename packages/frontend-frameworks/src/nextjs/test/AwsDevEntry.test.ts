import { spawnSync } from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { NextjsAwsDevEntryConfig } from "../aws-dev-entry.ts";

const entry = fileURLToPath(new URL("../aws-dev-entry.ts", import.meta.url));

// The entry is always run under plain `node` (never bun) with the same
// type-transform flags `nextjs/aws.ts`'s spawn computes — probe the REAL
// node on PATH (this test process may be bun-hosted).
const nodeVersion = spawnSync("node", ["-p", "process.versions.node"], {
  encoding: "utf8",
}).stdout?.trim();
const [major = 0, minor = 0] = (nodeVersion ?? "").split(".").map(Number);
const transformFlags =
  (major === 22 && minor >= 7) || (major >= 23 && major < 26)
    ? ["--experimental-transform-types", "--no-warnings=ExperimentalWarning"]
    : [];
const canRunTsEntry = (major === 22 && minor >= 7) || major >= 23;

const tempDirs: Array<string> = [];
const makeTempDir = (): string => {
  const dir = NodeFs.mkdtempSync(
    NodePath.join(NodeOs.tmpdir(), "alchemy-nextjs-aws-dev-entry-test-"),
  );
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tempDirs) {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

const runEntry = (config?: NextjsAwsDevEntryConfig) =>
  spawnSync(
    "node",
    [
      ...transformFlags,
      entry,
      ...(config === undefined ? [] : [JSON.stringify(config)]),
    ],
    { encoding: "utf8", timeout: 25_000 },
  );

describe.skipIf(!canRunTsEntry)("aws-dev-entry", () => {
  it("fails loudly when the JSON config argument is missing", () => {
    const result = runEntry();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("next dev child failed to start");
    expect(result.stderr).toContain("missing the JSON config argument");
  });

  it("resolves the project's next (no effect dispatch — the mount owns dev HTTP)", () => {
    const root = makeTempDir();
    const result = runEntry({ root, port: 0 });
    // The failure is the (absent) `next` resolved from the project root —
    // the entry carries no effect dispatch stage anymore (Serve/DESIGN.md:
    // the user's route-file mount runs natively inside next dev).
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Cannot find (module|package) '?next/);
  });
});
