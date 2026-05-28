import * as Alchemy from "alchemy";
import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const region = "eu-west-3";
const port = 3000;

const serviceName =
  process.env.PRISMA_EFFECT_SERVICE ?? "alchemy-prisma-compute-effect";
const projectName = process.env.PRISMA_PROJECT ?? `${serviceName}-project`;
const message =
  process.env.PRISMA_EFFECT_MESSAGE ??
  "hello from Effect-native Prisma Compute";

const runtimeEnv = (key: string, fallback: string) =>
  Effect.sync(() => process.env[key] ?? fallback);

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

export const Api = Prisma.Compute(
  "Api",
  Effect.gen(function* () {
    const project = yield* Project;
    const branch = yield* MainBranch;
    return {
      project,
      serviceName,
      regionId: region,
      branchId: branch.branchId,
      main: import.meta.filename,
      handler: "Api" as const,
      port,
      env: {
        PRISMA_EFFECT_MESSAGE: message,
        PRISMA_PROJECT_ID: project.projectId,
        PRISMA_BRANCH_ID: branch.branchId,
      },
      destroyOldVersion: true,
    };
  }),
  Effect.gen(function* () {
    const db = yield* Prisma.Connection.bind(Connection);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");

        if (url.pathname !== "/" && url.pathname !== "/api/health") {
          return HttpServerResponse.text("Not found", { status: 404 });
        }

        if (request.method !== "GET") {
          return HttpServerResponse.text("Method not allowed", { status: 405 });
        }

        const databaseUrl = yield* db.databaseUrl;
        const response = {
          ok: true,
          mode: "effect-native",
          message: yield* runtimeEnv("PRISMA_EFFECT_MESSAGE", message),
          projectId: yield* runtimeEnv("PRISMA_PROJECT_ID", ""),
          branchId: yield* runtimeEnv("PRISMA_BRANCH_ID", ""),
          databaseId: yield* db.databaseId,
          connectionId: yield* db.connectionId,
          hasDatabaseUrl: databaseUrl !== undefined,
        };

        return yield* HttpServerResponse.json(response);
      }),
    };
  }).pipe(Effect.provide(Prisma.ConnectionBindingLive)),
);

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
      computeServiceId: api.computeServiceId,
      computeVersionId: api.computeVersionId,
      url: api.url,
    };
  }),
);
