import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "alchemy/Test/Vitest": fileURLToPath(
        new URL("../../../src/Test/Vitest.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["**/*.fixture.ts"],
    sequence: { hooks: "stack" },
  },
});
