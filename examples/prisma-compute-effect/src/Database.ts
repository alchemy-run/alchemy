import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";

export const region = "eu-west-3";

const serviceName =
  process.env.PRISMA_EFFECT_SERVICE ?? "alchemy-prisma-compute-effect";
const projectName = process.env.PRISMA_PROJECT ?? `${serviceName}-project`;

export const Project = Prisma.Project("Project", {
  name: projectName,
  createDatabase: false,
  region,
});

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
