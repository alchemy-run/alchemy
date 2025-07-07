import { defineConfig } from "tsup";
import { migrations } from "./src/internal/migrations";

export default defineConfig({
  entry: [
    "src/base.ts",
    "src/bun-sqlite.ts",
    "src/d1.ts",
    "src/better-sqlite3.ts",
    "src/libsql.ts",
  ],
  outDir: "dist",
  target: "node20",
  format: "esm",
  clean: true,
  sourcemap: true,
  dts: true,
  external: ["alchemy", "bun:sqlite", "better-sqlite3", "@libsql/client"],
  define: {
    "process.env.ALCHEMY_MIGRATIONS": JSON.stringify(migrations),
  },
});
