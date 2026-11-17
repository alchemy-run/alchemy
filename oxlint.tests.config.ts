import { defineConfig } from "oxlint";

// Test files are excluded from oxlint.config.ts (type-aware, source-only rules),
// so their own rules live here.
export default defineConfig({
  plugins: [],
  categories: { correctness: "off" },
  jsPlugins: ["./scripts/oxlint/test-tags.ts"],
  ignorePatterns: ["**/fixtures/**"],
  rules: {
    "alchemy-test/require-kind-tag": "error",
  },
});
