import { afterAll, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { alchemy } from "../src/alchemy.js";
import { Bundle } from "../src/esbuild/bundle.js";
import { BRANCH_PREFIX } from "./util.js";

import { destroy } from "../src/destroy.js";
import "../src/test/bun.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const out = path.join(".alchemy", ".out");
const outputFile = path.join(out, "handler.js");

afterAll(async () => {
  await fs.rmdir(out);
});

test("bundle and cleanup", async (scope) => {
  const bundle = await Bundle("bundle", {
    entryPoint: path.join(import.meta.dirname, "handler.ts"),
    outdir: out,
    format: "esm",
    platform: "node",
    target: "node18",
  });

  try {
    // Apply the bundle
    expect(bundle.path).toBe(outputFile);
    expect(bundle.hash).toBeTruthy();

    // Verify the file exists and contains our code
    expect(await fs.exists(outputFile)).toBe(true);
    const contents = await fs.readFile(outputFile, "utf-8");
    expect(contents).toContain("Hello from bundled handler");
  } finally {
    await destroy(scope);
    expect(await fs.exists(outputFile)).toBe(false);
  }
});
