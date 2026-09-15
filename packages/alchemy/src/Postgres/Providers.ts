import * as Layer from "effect/Layer";
import * as Provider from "../Provider.ts";
import { Database } from "./Database.ts";
import { PostgresDatabaseProvider } from "./DatabaseProvider.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Postgres",
) {}

/**
 * Build a layer that registers the Postgres Database resource provider.
 * Include this from your stack alongside other cloud `providers()` layers.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Postgres from "alchemy/Postgres";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Layer.mergeAll(Cloudflare.providers(), Postgres.providers()),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const db = yield* Postgres.Database("app-db", {
 *       connectionString: Secret("DATABASE_URL"),
 *       migrationsDir: "./migrations",
 *     });
 *     return { connectionUri: db.connectionUri };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Database])).pipe(
    Layer.provide(PostgresDatabaseProvider()),
    Layer.orDie,
  );
