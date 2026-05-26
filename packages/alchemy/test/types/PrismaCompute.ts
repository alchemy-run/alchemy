import * as Prisma from "@/Prisma";
import type { RuntimeContext } from "@/RuntimeContext";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

declare const connection: Prisma.Connection;

interface ApiShape {
  connectionId(): Effect.Effect<string, never, RuntimeContext>;
}

export class PrismaComputeApi extends Prisma.Compute<
  PrismaComputeApi,
  ApiShape
>()("PrismaComputeApi", {
  project: "project-1",
  serviceName: "api",
  main: import.meta.filename,
}) {}

export const PrismaComputeApiLive = PrismaComputeApi.make(
  Effect.gen(function* () {
    const db = yield* Prisma.Connection.bind(connection);

    return PrismaComputeApi.of({
      connectionId: () => db.connectionId,
      fetch: Effect.gen(function* () {
        const databaseUrl = yield* db.databaseUrl;
        const exitCode = yield* Effect.gen(function* () {
          const child = yield* ChildProcess.make("echo", ["ok"]);
          return yield* child.exitCode;
        }).pipe(Effect.catch(() => Effect.succeed(-1)));
        return yield* HttpServerResponse.json({
          ok: true,
          hasDatabaseUrl: databaseUrl !== undefined,
          exitCode,
        });
      }),
    });
  }).pipe(Effect.provide(Prisma.ConnectionBindingLive)),
);
