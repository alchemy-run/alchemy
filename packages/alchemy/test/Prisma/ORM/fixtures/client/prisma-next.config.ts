import { defineConfig } from "@prisma/orm-postgres/config";

export default defineConfig({
  contract: "./contract.prisma",
  output: "./generated",
});
