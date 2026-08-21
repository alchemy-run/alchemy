import * as Drizzle from "alchemy/Drizzle";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";

export const API_PORT = 3000;

export const Site = Fly.App("Site", {
  enableSubdomains: true,
});

/**
 * Drizzle schema + Fly Managed Postgres. `migrations: schema` makes
 * `Drizzle.Schema` regenerate pending SQL, then `Fly.Postgres` applies
 * it on deploy.
 */
export const Schema = Drizzle.Schema("app-schema", {
  schema: "./src/schema.ts",
  out: "./migrations",
});

export const Db = Fly.Postgres(
  "Db",
  Effect.gen(function* () {
    // Yield the schema so the cluster depends on it: Drizzle regenerates
    // pending SQL first, then Fly.Postgres applies it.
    const schema = yield* Schema;
    return { region: "iad", migrations: schema };
  }),
);

export const PublicIp = Fly.IpAssignment("Shared", {
  app: Site,
  type: "shared_v4",
});
