import * as Neon from "alchemy/Neon";
import * as SQL from "alchemy/SQL/Postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { resources } from "./resources.ts";

export default class Api extends Neon.Function<Api>()(
  "Api",
  Effect.gen(function* () {
    const { branch } = yield* resources;
    return { branch, main: import.meta.url };
  }),
  Effect.gen(function* () {
    const { branch, uploads } = yield* resources;
    const db = yield* Neon.Connect(branch);
    const sql = yield* SQL.Postgres({ url: db.connectionString });
    const files = yield* Neon.ReadBucket(uploads);
    const token = yield* Config.Redacted("APP_TOKEN");
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.headers.authorization !== `Bearer ${Redacted.value(token)}`)
          return HttpServerResponse.empty({ status: 401 });
        yield* Effect.addFinalizer(() => Effect.log("request complete"));
        const rows = yield* sql`SELECT current_database() AS database`.pipe(
          Effect.orDie,
        );
        const objects = yield* files
          .list({ prefix: "uploads/" })
          .pipe(Effect.orDie);
        return yield* HttpServerResponse.json({ rows, objects });
      }),
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(Neon.ConnectHttp, Neon.ReadBucketHttp)),
  ),
) {}
