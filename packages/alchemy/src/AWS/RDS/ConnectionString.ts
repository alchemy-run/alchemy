import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  Connect,
  type ConnectionInfo,
  type ConnectOptions,
} from "./Connect.ts";
import type { DBCluster } from "./DBCluster.ts";
import type { DBProxy } from "./DBProxy.ts";
import type { DBProxyEndpoint } from "./DBProxyEndpoint.ts";

type ConnectResource = DBCluster | DBProxy | DBProxyEndpoint;

const formatConnectionString = (c: ConnectionInfo): string => {
  const user = c.username ? encodeURIComponent(c.username) : "";
  const pass = c.password ? `:${encodeURIComponent(c.password)}` : "";
  const auth = user ? `${user}${pass}@` : "";
  const database = c.database ? `/${encodeURIComponent(c.database)}` : "";
  const query = c.ssl ? "?sslmode=require" : "";
  return `postgres://${auth}${c.host}:${c.port}${database}${query}`;
};

/**
 * Runtime binding that resolves a `postgres://` connection string for an Aurora
 * cluster, RDS Proxy, or proxy endpoint. Like {@link Connect} but formats the
 * resolved {@link ConnectionInfo} into a single redacted URL — ready to hand
 * straight to `Drizzle.postgres(...)`.
 *
 * @example In-VPC drizzle over a pooled connection
 * ```typescript
 * const connStr = yield* AWS.RDS.connectionString(db.cluster, {
 *   secret: db.secret,
 *   database: "app",
 * });
 * const pg = yield* Drizzle.postgres(connStr, { relations });
 * const rows = yield* pg.select().from(Users);
 * ```
 *
 * @example Fronting Aurora with Cloudflare Hyperdrive
 * ```typescript
 * // Hyperdrive accepts the cluster's endpoint Outputs directly. Supply a known
 * // master password (e.g. via alchemy.secret) when creating the cluster so it
 * // can be passed to the origin — Hyperdrive needs the password at deploy time.
 * const hd = yield* Cloudflare.Hyperdrive("AppHyperdrive", {
 *   origin: {
 *     scheme: "postgres",
 *     host: db.cluster.endpoint,
 *     port: db.cluster.port,
 *     database: "app",
 *     user: "app",
 *     password: alchemy.secret.env.DB_PASSWORD,
 *   },
 * });
 * ```
 */
export const connectionString = (
  resource: ConnectResource,
  options: ConnectOptions,
) =>
  Effect.map(Connect(resource, options), (info) =>
    Effect.map(info, (c) => Redacted.make(formatConnectionString(c))),
  );
