import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import * as Output from "../Output.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { envName } from "../Util/EnvName.ts";
import type { Database } from "./Database.ts";

export interface ConnectClient {
  uri: Effect.Effect<string, never, RuntimeContext>;
  databaseName: Effect.Effect<string, never, RuntimeContext>;
  databaseIdentity: Effect.Effect<string, never, RuntimeContext>;
  host: Effect.Effect<string, never, RuntimeContext>;
  dashboardUrl: Effect.Effect<string | undefined, never, RuntimeContext>;
  token: Effect.Effect<
    Redacted.Redacted<string> | undefined,
    never,
    RuntimeContext
  >;
}

export interface Connect extends Binding.Service<
  Connect,
  "SpacetimeDB.Connect",
  (database: Database) => Effect.Effect<ConnectClient>
> {}

export const Connect = Binding.Service<Connect>("SpacetimeDB.Connect");

export interface ConnectEnvKeys {
  uri: string;
  databaseName: string;
  databaseIdentity: string;
  host: string;
  dashboardUrl: string;
  token: string;
}

export const connectEnvKeys = (
  database: Pick<Database, "FQN" | "LogicalId">,
): ConnectEnvKeys => {
  const name =
    database.FQN === database.LogicalId ? database.LogicalId : database.FQN;
  const prefix = `SPACETIMEDB_${envName(name)}`;
  return {
    uri: `${prefix}_URI`,
    databaseName: `${prefix}_DATABASE_NAME`,
    databaseIdentity: `${prefix}_DATABASE_IDENTITY`,
    host: `${prefix}_HOST`,
    dashboardUrl: `${prefix}_DASHBOARD_URL`,
    token: `${prefix}_TOKEN`,
  };
};

/**
 * Vite environment bindings derived from a {@link Database} resource.
 *
 * Spread this into `Cloudflare.Website.Vite(...).env` so the SPA gets the
 * connection coordinates inlined into the client bundle as
 * `import.meta.env.VITE_*`:
 *
 * ```typescript
 * const site = yield* Cloudflare.Website.Vite("Web", {
 *   env: { ...SpacetimeDB.viteEnv(db), API: api.url },
 * });
 * ```
 */
export const viteEnv = (
  database: Pick<Database, "uri" | "databaseName" | "dashboardUrl">,
): Record<string, Output.Output<string>> => ({
  VITE_SPACETIMEDB_URI: database.uri as unknown as Output.Output<string>,
  VITE_SPACETIMEDB_DATABASE_NAME:
    database.databaseName as unknown as Output.Output<string>,
  VITE_SPACETIMEDB_DASHBOARD_URL: Output.map(
    database.dashboardUrl as unknown as Output.Output<string | undefined>,
    (u: string | undefined) => u ?? "",
  ),
});
