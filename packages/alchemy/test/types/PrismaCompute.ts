import * as Prisma from "@/Prisma";
import type { RuntimeContext } from "@/RuntimeContext";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

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
        return HttpServerResponse.json({
          ok: true,
          hasDatabaseUrl: databaseUrl !== undefined,
        });
      }),
    });
  }).pipe(Effect.provide(Prisma.ConnectionBindingLive)),
);
