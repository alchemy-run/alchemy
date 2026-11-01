import {
  MigrationError,
  probeExecutor,
  runMigrations,
  withPgExecutor,
  type NormalizedMigrationsInput,
  type StampedMigrationsState,
} from "@alchemy.run/sql/Migrations";
import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { PostgresScope } from "./internal.ts";

const CONNECT_TIMEOUT_MILLIS = 15_000;

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
]);

/** PostgreSQL's `invalid_authorization_specification` and `invalid_password`. */
const LOGIN_CODES = new Set(["28000", "28P01"]);

const driverError = (cause: unknown) => cause as { code?: unknown; message?: unknown } | null;

/** The driver reports its own connect timeout without a code. */
const isNetworkFailure = (cause: unknown): boolean => {
  const error = driverError(cause);
  return (
    (typeof error?.code === "string" && NETWORK_CODES.has(error.code)) ||
    (typeof error?.message === "string" && error.message.includes("timeout"))
  );
};

const isLoginFailure = (cause: unknown): boolean => {
  const code = driverError(cause)?.code;
  return typeof code === "string" && LOGIN_CODES.has(code);
};

/**
 * Apply pending migrations over a direct `pg` connection, the only way in: the API
 * has no SQL endpoint. Connecting is what needs the deployer's IP in the instance's
 * ACL. Credentials are only checked when there are migrations to apply.
 */
export const runDatabaseMigrations = (options: {
  readonly scope: PostgresScope;
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
              "and migrationsPassword, e.g. from a Stackit.PostgresFlex.User that owns it.",
          });
        }
        const instance = yield* postgres.getInstance({ ...options.scope, instanceId });
        if (instance.network.accessScope === "SNA") {
          return yield* new MigrationError({
            message:
              `Instance '${instance.name}' has access scope SNA, so it can't be reached from ` +
              "the deploying machine, and PostgreSQL Flex has no SQL API to run migrations through.",
          });
        }
        const { host, port } = instance.connectionInfo.write;
        yield* withPgExecutor(
          {
            host,
            port,
            database,
            user,
            password: Redacted.isRedacted(password) ? Redacted.value(password) : password,
            // STACKIT only accepts TLS, with signed certificates.
            ssl: { rejectUnauthorized: true },
            connectionTimeoutMillis: CONNECT_TIMEOUT_MILLIS,
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
                      `${error.message} — PostgreSQL Flex only accepts connections from the ` +
                      `instance's ACL. Add this machine's public IP as a /32 to the acl of ` +
                      `instance '${instance.name}'.`,
                    cause: error.cause,
                  })
                : error,
          },
        );
      }),
  });
