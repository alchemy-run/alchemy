import { runChangedTests } from "../src/test/prune.js";

/**
 * This script detects which tests have changed using esbuild and git and then runs only those tests.
 */

const sinceIdx = process.argv.indexOf("--since");
const since =
  (sinceIdx !== -1 ? process.argv[sinceIdx + 1] : undefined) ?? "HEAD~1";

const vitestIdx = process.argv.indexOf("--vitest");
const useVitest = vitestIdx !== -1;

await runChangedTests(import.meta.dirname, since, useVitest);
