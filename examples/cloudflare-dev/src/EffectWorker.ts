import * as PgClient from "@effect/sql-pg/PgClient";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const KV = Cloudflare.KVNamespace("KV");
export const Hyperdrive = Cloudflare.Hyperdrive("Hyperdrive", {
  // should this support a raw connection string?
  origin: {
    // TODO: provision with Neon
    scheme: "postgresql",
    host: process.env.PGHOST!,
    database: process.env.PGDATABASE!,
    user: process.env.PGUSER!,
    password: Redacted.make(process.env.PGPASSWORD!),
  },
  // should this default to the production origin?
  dev: {
    scheme: "postgresql",
    host: process.env.PGHOST!,
    port: 5432,
    database: process.env.PGDATABASE!,
    user: process.env.PGUSER!,
    password: Redacted.make(process.env.PGPASSWORD!),
  },
});

export default class EffectWorker extends Cloudflare.Worker<EffectWorker>()(
  "EffectWorker",
  {
    main: import.meta.path,
  },
  Effect.gen(function* () {
    const kv = yield* Cloudflare.KVNamespace.bind(KV);
    const hyperdrive = yield* Cloudflare.Hyperdrive.bind(Hyperdrive);

    const pgLayer = hyperdrive.connectionString.pipe(
      Effect.map((connectionString) =>
        PgClient.layer({
          url: Redacted.make(connectionString),
        }),
      ),
      Layer.unwrap,
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        switch (request.url) {
          case "/": {
            return HttpServerResponse.text("Hello, world!");
          }
          case "/kv": {
            const list = yield* kv.list();
            return HttpServerResponse.jsonUnsafe(list);
          }
          case "/pg": {
            const res = yield* SqlClient.SqlClient.use((sql) => sql`SELECT 1`);
            return HttpServerResponse.jsonUnsafe(res);
          }
          default:
            return HttpServerResponse.text("Not found", { status: 404 });
        }
      }).pipe(Effect.provide(pgLayer), Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.merge(
        Cloudflare.KVNamespaceBindingLive,
        Cloudflare.HyperdriveConnectionLive, // should this be called HyperdriveBindingLive for consistency?
      ),
    ),
  ),
) {}
