import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type { PresignError } from "@distilled.cloud/aws/Presign";
import type * as Region from "@distilled.cloud/aws/Region";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { generateDbAuthToken } from "../Connection/DbAuthToken.ts";
import {
  type SqlConnectionInfo,
  connectEnvPrefix as makeConnectEnvPrefix,
  formatSqlConnectionUrl,
} from "../Connection/internal.ts";
import type { Cluster } from "./Cluster.ts";

export interface ConnectOptions {
  /**
   * Connect as the built-in `admin` role. Grants `dsql:DbConnectAdmin` on the
   * cluster (instead of `dsql:DbConnect`) and signs the auth token for the
   * `DbConnectAdmin` action.
   * @default false
   */
  admin?: boolean;
  /**
   * Database role to connect as when `admin` is not set. Must be a Postgres
   * role in the cluster that was granted to an IAM identity via
   * `AWS IAM GRANT`.
   */
  username?: string;
  /**
   * Database to connect to.
   * @default "postgres"
   */
  database?: string;
}

/**
 * Environment variable prefix under which {@link Connect} publishes the
 * cluster endpoint on the host Function, derived from the cluster's logical
 * ID. A cluster with logical ID `AppDb` yields `DSQL_APPDB` and the variable
 * `DSQL_APPDB_HOST`.
 */
export const connectEnvPrefix = (logicalId: string): string =>
  makeConnectEnvPrefix("DSQL", logicalId);

/**
 * Runtime binding that resolves connection settings for an Aurora DSQL
 * cluster using IAM database authentication.
 *
 * DSQL clusters expose a **public** Postgres-wire endpoint
 * (`<clusterId>.dsql.<region>.on.aws:5432`) and authenticate exclusively
 * with short-lived IAM auth tokens — there is no password secret and no VPC
 * requirement. The deploy half grants `dsql:DbConnect` (or
 * `dsql:DbConnectAdmin` with `admin: true`) on the cluster to the host
 * Function; the runtime half mints a presigned token client-side (a pure
 * SigV4 computation, no API call) and returns a {@link SqlConnectionInfo}
 * whose `url` feeds `Drizzle.Postgres` / any Postgres client directly.
 *
 * Token freshness is structural: yielding the returned connection effect
 * re-mints the token, and execution-scoped pools (`Drizzle.Postgres`)
 * rebuild per execution — a ~15-minute token can never outlive its pool.
 *
 * ### Connecting to a Cluster
 * **Example:** Resolve Connection Info inside a Function
 * ```typescript
 * const conn = yield* DSQL.Connect(cluster, { admin: true });
 * // inside a handler — each yield mints a fresh auth token:
 * const { host, port, username, password, url } = yield* conn;
 * ```
 *
 * **Example:** Drizzle over DSQL
 * ```typescript
 * const conn = yield* DSQL.Connect(cluster, { admin: true });
 * const db = yield* Drizzle.Postgres(conn.pipe(Effect.map((info) => info.url)));
 * // inside a handler:
 * const rows = yield* db.select().from(Widgets);
 * ```
 *
 * **Example:** Connect as a Custom Database Role
 * ```typescript
 * const conn = yield* DSQL.Connect(cluster, {
 *   username: "app",
 *   database: "postgres",
 * });
 * ```
 *
 * @binding
 */
export interface Connect extends Binding.Service<
  Connect,
  "AWS.DSQL.Connect",
  (
    cluster: Cluster,
    options?: ConnectOptions,
  ) => Effect.Effect<Effect.Effect<SqlConnectionInfo, PresignError, RuntimeContext>>
> {}
export const Connect = Binding.Service<Connect>("AWS.DSQL.Connect");

const DSQL_PORT = 5432;

/**
 * IAM-token implementation of {@link Connect}. At deploy time it grants
 * `dsql:DbConnect` (or `dsql:DbConnectAdmin`) on the cluster to the host
 * Function and publishes the endpoint as `DSQL_{LOGICAL_ID}_HOST`; at runtime
 * it presigns a fresh auth token (client-side SigV4 — no API call) with the
 * Function's own credentials and formats the full connection descriptor.
 */
export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    // Captured at layer build so the runtime callable only requires
    // RuntimeContext — the presign resolves credentials lazily from the
    // service on every mint, so refreshed execution-role creds are honored.
    const services = yield* AWSBindings.withCredentials(
      Effect.context<Credentials.Credentials | Region.Region>(),
    );

    return Effect.fn(function* (cluster: Cluster, options?: ConnectOptions) {
      const Host = yield* cluster.endpoint;
      const admin = options?.admin ?? false;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const prefix = connectEnvPrefix(cluster.LogicalId);
        yield* bind`AWS.DSQL.Connect(${cluster})`({
          env: {
            [`${prefix}_HOST`]: cluster.endpoint,
          },
          policyStatements: [
            {
              Effect: "Allow",
              Action: [admin ? "dsql:DbConnectAdmin" : "dsql:DbConnect"],
              Resource: [cluster.clusterArn],
            },
          ],
        });
      }

      const username = admin ? "admin" : options?.username;
      const database = options?.database ?? "postgres";

      return Effect.gen(function* () {
        const host = yield* Host;
        if (!host) {
          return yield* Effect.die(`DSQL endpoint for '${cluster.LogicalId}' is not available yet`);
        }
        const password = yield* generateDbAuthToken({
          service: "dsql",
          hostname: host,
          action: admin ? "DbConnectAdmin" : "DbConnect",
        }).pipe(Effect.provideContext(services));
        return {
          host,
          port: DSQL_PORT,
          database,
          username,
          password,
          ssl: true,
          url: formatSqlConnectionUrl({
            host,
            port: DSQL_PORT,
            database,
            username,
            password,
            ssl: true,
          }),
        } satisfies SqlConnectionInfo;
      });
    });
  }),
);
