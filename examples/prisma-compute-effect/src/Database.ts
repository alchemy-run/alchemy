import * as Prisma from "alchemy/Prisma";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const region = "eu-west-3";

export const serviceNameConfig = Config.string("PRISMA_EFFECT_SERVICE").pipe(
  Effect.orElseSucceed(() => "alchemy-prisma-compute-effect"),
);

export const Project = Prisma.Project(
  "Project",
  Effect.gen(function* () {
    const serviceName = yield* serviceNameConfig;

    return {
      name: yield* Config.string("PRISMA_PROJECT").pipe(
        Effect.orElseSucceed(() => `${serviceName}-project`),
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
      name: "main",
      region,
      branchId: branch.branchId,
      isDefault: true,
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
