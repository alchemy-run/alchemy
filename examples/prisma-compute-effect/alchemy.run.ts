import * as Alchemy from "alchemy";
import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Connection, MainBranch, Postgres, Project } from "./src/Database.ts";

export default Alchemy.Stack(
  "PrismaComputeEffect",
  {
    providers: Prisma.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const project = yield* Project;
    const branch = yield* MainBranch;
    const postgres = yield* Postgres;
    const connection = yield* Connection;
    const api = yield* Api;

    return {
      projectId: project.projectId,
      branchId: branch.branchId,
      databaseId: postgres.databaseId,
      connectionId: connection.connectionId,
      appId: api.appId,
      deploymentId: api.deploymentId,
      url: api.url,
    };
  }),
);
