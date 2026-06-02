import * as Prisma from "alchemy/Prisma";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Connection, MainBranch, Project, region } from "./Database.ts";

const port = 3000;

const serviceName =
  process.env.PRISMA_EFFECT_SERVICE ?? "alchemy-prisma-compute-effect";
const message =
  process.env.PRISMA_EFFECT_MESSAGE ??
  "hello from Effect-native Prisma Compute";
const verifyUrl = process.env.PRISMA_EFFECT_VERIFY_URL !== "false";
const urlReadinessTimeoutSeconds = Number(
  process.env.PRISMA_EFFECT_URL_TIMEOUT_SECONDS ?? "60",
);

const runtimeEnv = (key: string, fallback: string) =>
  Effect.sync(() => process.env[key] ?? fallback);

export default class Api extends Prisma.Compute<Api>()(
  "Api",
  Effect.gen(function* () {
    const project = yield* Project;
    yield* MainBranch;
    return {
      project,
      serviceName,
      regionId: region,
      branchGitName: "main",
      main: import.meta.filename,
      port,
      env: {
        PRISMA_EFFECT_MESSAGE: message,
      },
      verifyUrl,
      urlReadinessTimeoutSeconds,
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
          databaseId: yield* db.databaseId,
          connectionId: yield* db.connectionId,
          hasDatabaseUrl: databaseUrl !== undefined,
        };

        return yield* HttpServerResponse.json(response);
      }),
    };
  }).pipe(Effect.provide(Prisma.ConnectionBindingLive)),
) {}
