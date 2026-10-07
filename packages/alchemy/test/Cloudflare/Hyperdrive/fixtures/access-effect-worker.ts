import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import { Client } from "pg";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { AccessOriginConnection } from "./access-origin.ts";

/**
 * Effect Worker that binds the Access-protected Hyperdrive through
 * `Cloudflare.Hyperdrive.Connect` and runs a query through it, so a 200
 * proves the whole path: Hyperdrive → Access → Tunnel → Postgres.
 */
export default class HyperdriveAccessEffectWorker extends Cloudflare.Worker<HyperdriveAccessEffectWorker>()(
  "HyperdriveAccessEffectWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const connection = yield* AccessOriginConnection;
    const hd = yield* Cloudflare.Hyperdrive.Connect(connection);
    return {
      fetch: Effect.gen(function* () {
        const connectionString = Redacted.value(yield* hd.connectionString);
        return yield* Effect.tryPromise(async () => {
          const client = new Client({ connectionString });
          await client.connect();
          try {
            const result = await client.query("select 'through-access' as via");
            return result.rows[0] as { via: string };
          } finally {
            await client.end();
          }
        }).pipe(
          Effect.flatMap((row) => HttpServerResponse.json(row)),
          Effect.catch((error) =>
            Effect.succeed(HttpServerResponse.text(String(error), { status: 500 })),
          ),
        );
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}
