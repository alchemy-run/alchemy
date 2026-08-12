import { defineConfig } from "@prisma/orm-postgres/config";

export default defineConfig({
  contract: "./src/prisma/contract.prisma",
  output: "./src/prisma",
});
