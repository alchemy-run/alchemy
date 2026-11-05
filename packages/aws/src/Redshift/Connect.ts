import * as redshift from "@distilled.cloud/aws/redshift";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { toWireSeconds } from "alchemy/Util/Duration";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as AWSBindings from "../AWSBindings.ts";
import {
  connectEnvPrefix as makeConnectEnvPrefix,
  type SqlConnectionInfo,
  formatSqlConnectionUrl,
} from "../Connection/internal.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Connection descriptor for a provisioned Redshift cluster. Extends the
 * shared SQL shape with the temporary credential's expiration so callers
 * can reason about token lifetime (credentials are minted fresh on every
 * resolution of the runtime effect, so per-execution pools never outlive
 * them).
 */
export interface ClusterConnectionInfo extends SqlConnectionInfo {
  /**
   * When the temporary database credentials expire (15-60 minutes from
   * minting, per {@link ConnectOptions.duration}).
   */
  expiration: Date | undefined;
}

export interface ConnectOptions {
  /**
   * Database to connect to.
   * @default the cluster's initial database (`dbName` attribute)
   */
  database?: string;
  /**
   * Database user to mint temporary credentials for via
   * `redshift:GetClusterCredentials`. When omitted, credentials are minted
   * with `redshift:GetClusterCredentialsWithIAM` instead — the database
   * user is mapped 1:1 to the Function's IAM identity.
   */
  dbUser?: string;
  /**
   * Create the database user if it does not exist. Only used with
   * {@link ConnectOptions.dbUser}; adds `redshift:CreateClusterUser` to the
   * host's policy.
   * @default false
   */
  autoCreate?: boolean;
  /**
   * Database groups the user joins for the session. Only used with
   * {@link ConnectOptions.dbUser}; adds `redshift:JoinGroup` on each group
   * to the host's policy.
   */
  dbGroups?: string[];
  /**
   * How long the temporary credentials remain valid, e.g. `"15 minutes"` or
   * `Duration.minutes(30)` (a bare number is milliseconds). Rounded to whole
   * seconds on the wire; must land between 900 and 3600 seconds.
   * @default 900 seconds
   */
  duration?: Duration.Input;
  /**
   * Whether to require TLS on the connection.
   * @default true
   */
  ssl?: boolean;
}

/**
 * Errors the runtime credential mint can produce (`GetClusterCredentials`
 * and `GetClusterCredentialsWithIAM` share the same union).
 */
export type ConnectError =
  | redshift.GetClusterCredentialsError
  | redshift.GetClusterCredentialsWithIAMError;

/**
 * Environment variable prefix under which {@link Connect} publishes the
 * cluster endpoint on the host Function, derived from the cluster's logical
 * ID. A cluster with logical ID `Analytics` yields `REDSHIFT_ANALYTICS` and
 * the variables `REDSHIFT_ANALYTICS_HOST` / `REDSHIFT_ANALYTICS_PORT`.
 */
export const connectEnvPrefix = (logicalId: string): string =>
  makeConnectEnvPrefix("REDSHIFT", logicalId);

/**
 * Runtime binding that resolves pgwire connection settings for a
 * provisioned Redshift {@link Cluster} using IAM-minted temporary database
 * credentials.
 *
 * At deploy time it attaches the `redshift:GetClusterCredentials[WithIAM]`
 * IAM policy (scoped to the cluster's `dbname`/`dbuser` ARNs) and publishes
 * the cluster endpoint as environment variables. At runtime it calls the
 * corresponding SDK operation to mint short-lived credentials and returns a
 * typed {@link ClusterConnectionInfo} whose `url` feeds `Drizzle.Postgres`
 * directly.
 *
 * The Redshift Data API ({@link RedshiftData.Statements}) remains the
 * recommended default — it needs no driver, no VPC reach, and no credential
 * plumbing. Use `Connect` when you want a real pgwire connection (e.g.
 * Drizzle). Redshift speaks the postgres wire protocol on port 5439 —
 * configure Drizzle with `prepare: false` and avoid `RETURNING` (Redshift
 * does not support either). The host Function must be able to reach the
 * cluster endpoint (attach it to the cluster's VPC, or make the cluster
 * `publiclyAccessible`). Provide the implementation with
 * `Effect.provide(AWS.Redshift.ConnectHttp)`.
 *
 * ### Connecting to a Cluster
 * **Example:** Resolve Connection Info inside a Function (IAM identity)
 * ```typescript
 * const connect = yield* Redshift.Connect(cluster);
 * // inside a handler — mints fresh temporary credentials:
 * const { host, port, username, password, url } = yield* connect;
 * ```
 *
 * **Example:** Connect as a Named Database User
 * ```typescript
 * const connect = yield* Redshift.Connect(cluster, {
 *   dbUser: "etl",
 *   autoCreate: true,
 *   dbGroups: ["analysts"],
 *   database: "analytics",
 * });
 * ```
 *
 * **Example:** Drizzle over the Connection URL
 * ```typescript
 * const connect = yield* Redshift.Connect(cluster);
 * const db = yield* Drizzle.Postgres(
 *   Effect.map(connect, (info) => info.url),
 *   { prepare: false },
 * );
 * ```
 *
 * @binding
 */
export interface Connect extends Binding.Service<
  Connect,
  "AWS.Redshift.Connect",
  (
    cluster: Cluster,
    options?: ConnectOptions,
  ) => Effect.Effect<Effect.Effect<ClusterConnectionInfo, ConnectError, RuntimeContext>>
> {}
export const Connect = Binding.Service<Connect>("AWS.Redshift.Connect");

const DEFAULT_PORT = 5439;

const unwrap = (value: string | Redacted.Redacted<string> | undefined): string | undefined =>
  value === undefined ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;

/**
 * SDK-backed implementation of {@link Connect}. Deploy half attaches the
 * `redshift:GetClusterCredentials[WithIAM]` policy scoped to the cluster's
 * `dbname`/`dbuser`/`dbgroup` ARNs and publishes
 * `REDSHIFT_{LOGICAL_ID}_{HOST,PORT}` on the host Function; runtime half
 * mints temporary credentials via the corresponding SDK operation and
 * formats a pgwire connection URL.
 */
export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const getClusterCredentials = yield* AWSBindings.withCredentials(
      redshift.getClusterCredentials,
    );
    const getClusterCredentialsWithIAM = yield* AWSBindings.withCredentials(
      redshift.getClusterCredentialsWithIAM,
    );

    return Effect.fn(function* (cluster: Cluster, options: ConnectOptions = {}) {
      const ClusterIdentifier = yield* cluster.clusterIdentifier;
      const Host = yield* cluster.endpointAddress;
      const Port = yield* cluster.endpointPort;
      const DbName = yield* cluster.dbName;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // `arn:aws:redshift:{region}:{acct}` — the cluster ARN minus its
        // `:cluster:{id}` suffix; base for the dbname/dbuser/dbgroup ARNs
        // that scope the GetClusterCredentials* actions.
        const arnBase = Output.map(cluster.clusterArn, (arn) =>
          arn.slice(0, arn.lastIndexOf(":cluster:")),
        );
        const database = options.database ?? cluster.dbName;
        const dbNameArn = Output.interpolate`${arnBase}:dbname:${cluster.clusterIdentifier}/${database}`;
        const prefix = connectEnvPrefix(cluster.LogicalId);
        // The binding id must be unique per credential strategy: a Function
        // that connects to the same cluster both as its IAM identity and as
        // a named database user needs BOTH policy statements, and binds that
        // share an id collapse into one (the last one wins).
        const strategy = options.dbUser !== undefined ? `, ${options.dbUser}` : "";
        yield* bind`AWS.Redshift.Connect(${cluster}${strategy})`({
          policyStatements:
            options.dbUser !== undefined
              ? [
                  {
                    Effect: "Allow" as const,
                    Action: [
                      "redshift:GetClusterCredentials",
                      ...(options.autoCreate ? ["redshift:CreateClusterUser"] : []),
                    ],
                    Resource: [
                      Output.interpolate`${arnBase}:dbuser:${cluster.clusterIdentifier}/${options.dbUser}`,
                      dbNameArn,
                    ],
                  },
                  ...(options.dbGroups && options.dbGroups.length > 0
                    ? [
                        {
                          Effect: "Allow" as const,
                          Action: ["redshift:JoinGroup"],
                          Resource: options.dbGroups.map(
                            (group) =>
                              Output.interpolate`${arnBase}:dbgroup:${cluster.clusterIdentifier}/${group}`,
                          ),
                        },
                      ]
                    : []),
                ]
              : [
                  {
                    Effect: "Allow" as const,
                    Action: ["redshift:GetClusterCredentialsWithIAM"],
                    Resource: [dbNameArn],
                  },
                ],
          env: {
            [`${prefix}_HOST`]: cluster.endpointAddress,
            // Lambda environment variables are strings — stringify the port.
            [`${prefix}_PORT`]: Output.interpolate`${cluster.endpointPort}`,
          },
        });
      }

      return Effect.gen(function* () {
        const clusterIdentifier = yield* ClusterIdentifier;
        const host = yield* Host;
        const port = (yield* Port) ?? DEFAULT_PORT;
        const database = options.database ?? (yield* DbName);
        if (!host) {
          return yield* Effect.die(
            `Redshift cluster endpoint for '${cluster.LogicalId}' is not available yet`,
          );
        }
        const credentials =
          options.dbUser !== undefined
            ? yield* getClusterCredentials({
                ClusterIdentifier: clusterIdentifier,
                DbUser: options.dbUser,
                DbName: database,
                AutoCreate: options.autoCreate,
                DbGroups: options.dbGroups,
                DurationSeconds: toWireSeconds(options.duration),
              })
            : yield* getClusterCredentialsWithIAM({
                ClusterIdentifier: clusterIdentifier,
                DbName: database,
                DurationSeconds: toWireSeconds(options.duration),
              });
        const username = unwrap(credentials.DbUser);
        const rawPassword = unwrap(credentials.DbPassword);
        const password = rawPassword === undefined ? undefined : Redacted.make(rawPassword);
        const ssl = options.ssl ?? true;
        return {
          host,
          port,
          database,
          username,
          password,
          ssl,
          expiration: credentials.Expiration,
          url: formatSqlConnectionUrl({
            host,
            port,
            database,
            username,
            password,
            ssl,
          }),
        };
      });
    });
  }),
);
