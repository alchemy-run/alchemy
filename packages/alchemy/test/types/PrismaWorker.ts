import * as Cloudflare from "@/Cloudflare";
import * as Prisma from "@/Prisma";
import type { RuntimeContext } from "@/RuntimeContext";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

declare const connection: Prisma.Connection;

type ApiShape = {
  databaseUrl(): Effect.Effect<string | undefined, never, RuntimeContext>;
};

export class PrismaWorkerApi extends Cloudflare.Worker<
  PrismaWorkerApi,
  ApiShape
>()("PrismaWorkerApi") {}

export const PrismaWorkerApiLive = PrismaWorkerApi.make(
  {
    main: import.meta.filename,
    compatibility: {
      flags: ["nodejs_compat"],
    },
  },
  Effect.gen(function* () {
    const db = yield* Prisma.ConnectionBinding(connection);

    return PrismaWorkerApi.of({
      databaseUrl: () => db.databaseUrl,
      fetch: Effect.gen(function* () {
        const databaseUrl = yield* db.databaseUrl;
        return yield* HttpServerResponse.json({
          ok: true,
          hasDatabaseUrl: databaseUrl !== undefined,
        });
      }),
    });
  }).pipe(Effect.provide(Prisma.ConnectionBindingLive)),
);
