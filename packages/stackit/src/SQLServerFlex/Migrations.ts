import {
  MigrationError,
  probeExecutor,
  runMigrations,
  withMssqlExecutor,
  type NormalizedMigrationsInput,
  type StampedMigrationsState,
} from "@alchemy.run/sql/Migrations";
import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { listUserSummaries, type SqlServerScope } from "./internal.ts";

/** How long the driver waits for a connection, and for one request of a migration. */
const CONNECT_TIMEOUT_MILLIS = 15_000;
const REQUEST_TIMEOUT_MILLIS = 600_000;

/** The driver's `ConnectionError` codes for a server it couldn't reach. */
const NETWORK_CODES = new Set(["ESOCKET", "ETIMEOUT"]);

const driverCode = (cause: unknown) => (cause as { code?: unknown } | null)?.code;

const isNetworkFailure = (cause: unknown): boolean => {
  const code = driverCode(cause);
  return typeof code === "string" && NETWORK_CODES.has(code);
};

const isLoginFailure = (cause: unknown): boolean => driverCode(cause) === "ELOGIN";

/**
 * Where the instance listens. The instance has no such attribute: the API only
 * reports a host and port on a user, and they are the instance's.
 */
const endpointOf = (scope: SqlServerScope, instanceId: string, user: string) =>
  Effect.gen(function* () {
    const users = yield* listUserSummaries(scope, instanceId);
    const summary = users.find((candidate) => candidate.username === user) ?? users[0];
    if (summary === undefined) {
      return yield* new MigrationError({
        message:
          `Instance '${instanceId}' has no users, and STACKIT only reports its address ` +
          "on a user: add a Stackit.SQLServerFlex.User to run migrations.",
      });
    }
    return yield* sqlserver.getUser({ ...scope, instanceId, userId: summary.id });
  });

/**
 * Apply pending migrations over a direct TDS connection, the only way in: the API
 * has no SQL endpoint. Connecting is what needs the deployer's IP in the instance's
 * ACL. Credentials are only checked when there are migrations to apply.
 */
export const runDatabaseMigrations = (options: {
  readonly scope: SqlServerScope;
  readonly instanceId: string;
  readonly database: string;
  readonly input: NormalizedMigrationsInput;
  readonly stamped: StampedMigrationsState;
  readonly user: string | undefined;
  readonly password: string | Redacted.Redacted<string> | undefined;
}) =>
  runMigrations({
    input: options.input,
    stamped: options.stamped,
    withExecutor: (apply) =>
      Effect.gen(function* () {
        const { user, password, database, instanceId } = options;
        if (user === undefined || password === undefined) {
          return yield* new MigrationError({
            message:
              `Database '${database}' has migrations but no credentials: set migrationsUser ` +
              "and migrationsPassword, e.g. from a Stackit.SQLServerFlex.User that owns it.",
          });
        }
        const instance = yield* sqlserver.getInstance({ ...options.scope, instanceId });
        if (instance.network.accessScope === "SNA") {
          return yield* new MigrationError({
            message:
              `Instance '${instance.name}' has access scope SNA, so it can't be reached from ` +
              "the deploying machine, and SQL Server Flex has no SQL API to run migrations through.",
          });
        }
        const { host, port } = yield* endpointOf(options.scope, instanceId, user);
        yield* withMssqlExecutor(
          {
            server: host,
            port,
            database,
            user,
            password: Redacted.isRedacted(password) ? Redacted.value(password) : password,
            options: { encrypt: true, trustServerCertificate: false },
            connectionTimeout: CONNECT_TIMEOUT_MILLIS,
            requestTimeout: REQUEST_TIMEOUT_MILLIS,
          },
          (executor) => probeExecutor(executor).pipe(Effect.flatMap(apply)),
          {
            // A new ACL or user can take a moment to apply. Bounded to a few minutes
            // at worst, since each attempt can use up its connect timeout.
            retryConnect: {
              while: (cause) => isNetworkFailure(cause) || isLoginFailure(cause),
              times: 8,
              interval: "5 seconds",
            },
            onConnectFailure: (error) =>
              isNetworkFailure(error.cause)
                ? new MigrationError({
                    message:
                      `${error.message} — SQL Server Flex only accepts connections from the ` +
                      `instance's ACL. Add this machine's public IP as a /32 to the acl of ` +
                      `instance '${instance.name}'.`,
                    cause: error.cause,
                  })
                : error,
          },
        );
      }),
  });
