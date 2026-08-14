import { defineConfig } from "@prisma/orm-postgres/config";

export default defineConfig({
  contract: "./src/prisma/contract.ts",
  output: "./src/prisma",
});
