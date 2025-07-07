import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/internal/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
});
