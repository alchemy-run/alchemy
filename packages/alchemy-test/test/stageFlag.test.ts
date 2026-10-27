import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dirname, "../src/cli.ts");
const api = resolve(import.meta.dirname, "../src/index.ts");

const runWithStage = (stage: string) => {
  const root = mkdtempSync(join(tmpdir(), "alchemy-test-stage-flag-"));
  try {
    writeFileSync(
      join(root, "stage.test.ts"),
      `
      import { expect, test } from ${JSON.stringify(api)};
      test("sees the stage", () => {
        expect(process.env.ALCHEMY_TEST_STAGE).toBe(${JSON.stringify(stage)});
      });
    `,
    );
    const env = { ...process.env };
    delete env.ALCHEMY_TEST_STAGE;
    return spawnSync(process.execPath, [cli, "--stage", stage, "stage.test.ts"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("--stage sets ALCHEMY_TEST_STAGE before test modules load", () => {
  const result = runWithStage("test_sam_feat-x");
  expect(result.stdout + result.stderr).toContain("1 passed");
  expect(result.status).toBe(0);
}, 40_000);

test("--stage rejects names a stage can't hold", () => {
  const result = runWithStage("feat/x");
  expect(result.status).not.toBe(0);
}, 40_000);
