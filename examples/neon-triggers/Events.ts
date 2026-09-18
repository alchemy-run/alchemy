import * as Neon from "alchemy/Neon";
import * as SQL from "alchemy/SQL/Postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { resources } from "./resources.ts";

export default class Events extends Neon.Function<Events>()(
  "Events",
  Effect.gen(function* () {
    const { branch } = yield* resources;
    return { branch, main: import.meta.url };
  }),
  Effect.gen(function* () {
    const { branch, uploads } = yield* resources;
    const db = yield* Neon.Connect(branch);
    const sql = yield* SQL.Postgres({ url: db.connectionString });
    const record = (id: string, kind: string, key: string | null) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE IF NOT EXISTS processed_events (invocation_id text PRIMARY KEY, kind text NOT NULL, object_key text)`;
        // Keep application writes in this idempotent statement or the same transaction.
        yield* sql`INSERT INTO processed_events VALUES (${id}, ${kind}, ${key}) ON CONFLICT DO NOTHING`;
      });
    yield* Neon.CronEventSource("Nightly", { cron: "0 2 * * *" }, (event) =>
      record(event.invocationId, "schedule", null),
    );
    yield* Neon.BucketEventSource(
      uploads,
      { name: "Uploads", prefix: "incoming/" },
      (event) => record(event.invocationId, "upload", event.objectKey),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Neon.ConnectHttp,
        Neon.CronEventSourceHttp,
        Neon.BucketEventSourceHttp,
      ),
    ),
  ),
) {}
