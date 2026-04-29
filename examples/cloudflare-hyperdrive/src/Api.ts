import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Client } from "pg";
import { MyDb } from "./db";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.path,
    compatibility: {
      // node-postgres needs Node.js APIs to run inside a Worker.
      flags: ["nodejs_compat"],
    },
  },
  Effect.gen(function* () {
    const db = yield* Cloudflare.HyperdriveConnection.bind(MyDb);

    return {
      fetch: Effect.gen(function* () {
        const connectionString = yield* db.connectionString;

        return yield* Effect.promise(async () => {
          // Open a fresh client per request — Hyperdrive does the pooling
          // on the Cloudflare side, so the Worker doesn't need its own pool.
          const client = new Client({ connectionString });
          try {
            await client.connect();
            const results = await client.query(`SELECT * FROM pg_tables`);

            return HttpServerResponse.json({ ok: true, result: results.rows });
          } catch (cause) {
            return HttpServerResponse.json(
              {
                ok: false,
                error: cause instanceof Error ? cause.message : String(cause),
              },
              { status: 500 },
            );
          } finally {
            // `end()` returns a promise; await it so the Worker doesn't
            // tear down a half-closed socket.
            await client.end().catch(() => {});
          }
        });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.HyperdriveConnectionLive)),
) {}
