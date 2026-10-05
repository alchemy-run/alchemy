import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";
import { withEffect } from "alchemy/Prisma/ORM/generator";
import { definePrismaConfig } from "prisma/config";

export default definePrismaConfig({
  orm: withEffect(
    ormConfig({
      contract: "./src/prisma/contract.psl",
      output: "./src/prisma/generated",
    }),
    { client: true, schemas: true },
  ),
});
