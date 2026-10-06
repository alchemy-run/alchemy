import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";
import { withEffect } from "alchemy/Prisma/ORM/generator";
import { definePrismaConfig } from "prisma/config";

export default definePrismaConfig({
  orm: withEffect(
    ormConfig({
      contract: "./contract.psl",
      output: "./generated",
    }),
  ),
});
