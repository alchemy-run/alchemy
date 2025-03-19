import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { apply } from "../src/apply";
import { destroy } from "../src/destroy";
import { Bundle } from "../src/esbuild";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

describe("esbuild", () => {
  describe("Bundle", () => {
    const outputDir = ".out";
    const outputFile = path.join(outputDir, "handler.js");

    test("bundle and cleanup", async () => {
      const bundle = new Bundle("test-bundle", {
        entryPoint: path.join(__dirname, "handler.ts"),
        outdir: outputDir,
        format: "esm",
        platform: "node",
        target: "node18",
      });

      // Apply the bundle
      const output = await apply(bundle);
      expect(output.path).toBe(outputFile);
      expect(output.hash).toBeTruthy();

      // Verify the file exists and contains our code
      expect(fs.existsSync(outputFile)).toBe(true);
      const contents = await fs.promises.readFile(outputFile, "utf-8");
      expect(contents).toContain("Hello from bundled handler");

      // Destroy the bundle
      await destroy(bundle);

      // Verify the file is deleted
      expect(fs.existsSync(outputFile)).toBe(false);
    });
  });
});
