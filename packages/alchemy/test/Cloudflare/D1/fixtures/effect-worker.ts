import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestDatabase } from "./database.ts";
import { d1Routes } from "./routes.ts";

/**
 * Effect-native Worker fixture. Binds the shared {@link TestDatabase} via
 * native query and schema-introspection capabilities during Init, then
 * delegates to {@link d1Routes} with `style = "effect"`.
 */
export default class D1EffectWorker extends Cloudflare.Worker<D1EffectWorker>()(
  "D1EffectWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const database = yield* TestDatabase;
    const db = yield* Cloudflare.D1.QueryDatabase(database);
    const inspector = yield* Cloudflare.D1.IntrospectDatabase(database);
    return {
      fetch: d1Routes(db, inspector, "effect"),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.D1.IntrospectDatabaseBinding,
      ),
    ),
  ),
) {}
