import * as Drizzle from "alchemy/Drizzle";
import * as Fly from "alchemy/Fly";

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

export const Db = Fly.Postgres("Db", {
  region: "iad",
  migrations: Schema,
});

export const PublicIp = Fly.IpAssignment("Shared", {
  app: Site,
  type: "shared_v4",
});
