import * as AWS from "@/AWS";
import * as Prisma from "@/Prisma";
import type { RuntimeContext } from "@/RuntimeContext";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

declare const connection: Prisma.Connection;

type ApiShape = {
  databaseUrl(): Effect.Effect<string | undefined, never, RuntimeContext>;
};

export class PrismaLambdaApi extends AWS.Lambda.Function<
  PrismaLambdaApi,
  ApiShape
>()("PrismaLambdaApi") {}

export const PrismaLambdaApiLive = PrismaLambdaApi.make(
  {
    main: import.meta.filename,
    url: true,
  },
  Effect.gen(function* () {
    const db = yield* Prisma.ConnectionBinding(connection);

    return PrismaLambdaApi.of({
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
