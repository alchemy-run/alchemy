import type * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as GCPBindings from "../GCPBindings.ts";
import type { GcpHostBinding } from "../Host.ts";
import { CLOUD_SQL_MOUNT_PATH } from "../HostRuntime.ts";
import { grantFor } from "../HttpBinding.ts";
import type { SecretBindingTarget } from "../SecretManager/BindingHttp.ts";
import { ReadSecret, ReadSecretHttp } from "../SecretManager/ReadSecret.ts";
import type { Database } from "./Database.ts";
import type { Instance } from "./Instance.ts";
import type { User } from "./User.ts";

export interface ConnectOptions {
  /** Database to connect to. */
  database: Database;
  /** Built-in database user to log in as. */
  user: User;
  /**
   * Secret Manager secret whose `latest` version holds the user's
   * password.
   */
  passwordSecret: SecretBindingTarget;
}

export interface ConnectionInfo {
  /** Instance connection name `project:region:instance`. */
  connectionName: string;
  /** Unix socket directory, `/cloudsql/{connectionName}`. */
  socketPath: string;
  /** Database name. */
  database: string;
  /** Database user name. */
  username: string;
  /** Password read from the secret. */
  password: Redacted.Redacted<string>;
  /**
   * Connection URL over the Unix socket — `postgresql://…?host=/cloudsql/…`
   * for PostgreSQL, `mysql://…?socketPath=/cloudsql/…` for MySQL. Feed it
   * to `Drizzle.Postgres` / your driver. `Redacted` because it embeds the
   * password.
   */
  url: Redacted.Redacted<string>;
}

/** The password secret has no readable `latest` version. */
export class PasswordMissing extends Data.TaggedError("GCP.SQL.PasswordMissing")<{
  secret: string;
}> {}

/**
 * Runtime binding that connects a Cloud Run service to a Cloud SQL
 * instance over the Cloud SQL Unix socket — no public IP allow-list, no
 * VPC.
 *
 * Binding it at init grants `roles/cloudsql.client` on the project under
 * an IAM Condition naming only this instance, mounts the instance as the
 * service's `cloudsql` volume (the socket appears at
 * `/cloudsql/{connectionName}`), and grants
 * `roles/secretmanager.secretAccessor` on the password secret. The
 * returned Effect reads the password and resolves a {@link ConnectionInfo}
 * on each execution; no socket is opened. Provide
 * {@link ConnectHttp}. Cloud Run services only.
 *
 * ### Connecting with Drizzle
 * **Example:** Drizzle over the Cloud SQL socket
 * ```typescript
 * const connect = yield* GCP.SQL.Connect(instance, {
 *   database,
 *   user,
 *   passwordSecret,
 * });
 * const db = yield* Drizzle.Postgres(
 *   connect.pipe(Effect.map((info) => info.url)),
 * );
 * // …provided with Effect.provide(GCP.SQL.ConnectHttp)
 * ```
 *
 * @binding
 * @category SQL
 */
export interface Connect extends Binding.Service<
  Connect,
  "GCP.SQL.Connect",
  (
    instance: Instance,
    options: ConnectOptions,
  ) => Effect.Effect<
    Effect.Effect<
      ConnectionInfo,
      secretmanager.AccessProjectsSecretsVersionsError | PasswordMissing,
      RuntimeContext
    >
  >
> {}

export const Connect = Binding.Service<Connect>("GCP.SQL.Connect");

const socketUrl = (options: {
  databaseVersion: string | undefined;
  socketPath: string;
  database: string;
  username: string;
  password: string;
}) => {
  const mysql = (options.databaseVersion ?? "").toUpperCase().startsWith("MYSQL_");
  // The socket travels as a query parameter; `localhost` only satisfies
  // URL parsers that reject credentials with an empty host.
  const url = new URL(
    `${mysql ? "mysql" : "postgresql"}://localhost/${encodeURIComponent(options.database)}`,
  );
  url.username = encodeURIComponent(options.username);
  url.password = encodeURIComponent(options.password);
  url.searchParams.set(mysql ? "socketPath" : "host", options.socketPath);
  return url.toString();
};

/**
 * HTTP implementation of {@link Connect}: reads the password through
 * `GCP.SecretManager.ReadSecret` and connects over the Cloud Run
 * `cloudsql` socket volume.
 *
 * @layer
 * @provides GCP.SQL.Connect
 * @category SQL
 */
export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const readSecret = yield* ReadSecret;
    return Effect.fn(function* (instance: Instance, options: ConnectOptions) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // Connects over the socket volume Cloud Run mounts for the host.
        yield* GCPBindings.requireServiceAccountHost("GCP.SQL.Connect");
        yield* bind`GCP.SQL.Connect(${instance})`({
          // Cloud SQL has no instance-level IAM policy; an IAM Condition
          // scopes the project grant to this instance.
          iam: [
            grantFor(
              { role: "roles/cloudsql.client", scopeByCondition: true },
              Output.interpolate`projects/${instance.project}/instances/${instance.instanceName}`,
            ),
          ],
        });
        const host = yield* Binding.Host;
        if (host !== undefined) {
          const bindHost = (host as unknown as { bind: unknown }).bind as (
            label: TemplateStringsArray,
            ...args: unknown[]
          ) => (data: {
            cloudSqlInstances: Input<GcpHostBinding["cloudSqlInstances"]>;
          }) => Effect.Effect<void>;
          yield* bindHost`GCP.SQL.Socket(${instance})`({
            cloudSqlInstances: [
              Output.interpolate`${instance.project}:${instance.region}:${instance.instanceName}`,
            ],
          });
        }
      }
      const password = yield* readSecret(options.passwordSecret);
      const project = yield* instance.project;
      const region = yield* instance.region;
      const instanceName = yield* instance.instanceName;
      const databaseVersion = yield* instance.databaseVersion;
      const database = yield* options.database.databaseName;
      const username = yield* options.user.userName;
      const secretName = yield* options.passwordSecret.name;

      return Effect.gen(function* () {
        const value = yield* password.access();
        if (value === undefined) {
          return yield* new PasswordMissing({ secret: yield* secretName });
        }
        const connectionName = `${yield* project}:${yield* region}:${yield* instanceName}`;
        const socketPath = `${CLOUD_SQL_MOUNT_PATH}/${connectionName}`;
        const databaseName = yield* database;
        const userName = yield* username;
        const info: ConnectionInfo = {
          connectionName,
          socketPath,
          database: databaseName,
          username: userName,
          password: Redacted.make(value),
          url: Redacted.make(
            socketUrl({
              databaseVersion: yield* databaseVersion,
              socketPath,
              database: databaseName,
              username: userName,
              password: value,
            }),
          ),
        };
        return info;
      });
    });
  }),
).pipe(Layer.provide(ReadSecretHttp));
