import * as Prisma from "alchemy/Prisma";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const region = "eu-west-3" as const;

export const appNameConfig = Config.string("PRISMA_EFFECT_APP").pipe(
  Effect.orElseSucceed(() => "alchemy-prisma-compute-effect"),
);

export const Project = Prisma.Project(
  "Project",
  Effect.gen(function* () {
    const appName = yield* appNameConfig;

    return {
      name: yield* Config.string("PRISMA_PROJECT").pipe(
        Effect.orElseSucceed(() => `${appName}-project`),
      ),
      createDatabase: false,
      region,
    };
  }),
);

export const MainBranch = Prisma.Branch(
  "MainBranch",
  Effect.gen(function* () {
    const project = yield* Project;
    return {
      project,
      gitName: "main",
      isDefault: true,
    };
  }),
);

export const Postgres = Prisma.Postgres(
  "Postgres",
  Effect.gen(function* () {
    const project = yield* Project;
    const branch = yield* MainBranch;
    return {
      project,
      region,
      branchId: branch.branchId,
    };
  }),
);

export const Connection = Prisma.Connection(
  "Connection",
  Effect.gen(function* () {
    const postgres = yield* Postgres;
    return {
      database: postgres,
      name: "api",
    };
  }),
);
