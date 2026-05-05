import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Hyperdrive } from "./Db.ts";
import { Users } from "./schema.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.path,
  },
  Effect.gen(function* () {
    const conn = yield* Cloudflare.Hyperdrive.bind(Hyperdrive);
    const db = yield* Drizzle.postgres(conn.connectionString);

    return {
      fetch: Effect.gen(function* () {
        const users = yield* db.select().from(Users);
        return yield* HttpServerResponse.json(users);
      }).pipe(
        Effect.catch((cause: any) => {
          const peel = (e: any): any => (e?.cause ? peel(e.cause) : e);
          const root = peel(cause);
          return HttpServerResponse.json(
            {
              ok: false,
              error: String(cause),
              rootError: root?.message ?? String(root),
              rootCode: root?.code,
            },
            { status: 500 },
          );
        }),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.HyperdriveConnectionLive)),
) {}
