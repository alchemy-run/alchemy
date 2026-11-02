import {
  MigrationError,
  probeExecutor,
  runMigrations,
  withMySqlExecutor,
  type NormalizedMigrationsInput,
  type StampedMigrationsState,
} from "@alchemy.run/sql/Migrations";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { ProjectScope } from "../IaaS/internal.ts";
import { toRedacted, waitForCredential } from "../internal/dataServices.ts";
import { CREDENTIAL_LABEL, credentialApi } from "./internal.ts";

const CONNECT_TIMEOUT_MILLIS = 15_000;

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "PROTOCOL_CONNECTION_LOST",
]);

/** MariaDB's `ER_ACCESS_DENIED_ERROR` and `ER_DBACCESS_DENIED_ERROR`. */
const LOGIN_CODES = new Set(["ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR"]);

const driverCode = (cause: unknown): unknown => (cause as { code?: unknown } | null)?.code;

const isNetworkFailure = (cause: unknown): boolean => {
  const code = driverCode(cause);
  return typeof code === "string" && NETWORK_CODES.has(code);
};

const isLoginFailure = (cause: unknown): boolean => {
  const code = driverCode(cause);
  return typeof code === "string" && LOGIN_CODES.has(code);
};

/**
 * A credential that lives for one migration run: created, then deleted whatever
 * the run does. A delete that fails only leaves it behind until the instance goes,
 * so it warns and doesn't fail a deploy whose migrations succeeded.
 */
const withRunCredential = <A, E, R>(
  scope: ProjectScope,
  instanceId: string,
  use: (uri: Redacted.Redacted<string>) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    // Only the create: a wait that fails has to reach the release too.
    credentialApi.createCredential(scope, instanceId),
    (created) =>
      waitForCredential(credentialApi, CREDENTIAL_LABEL, scope, instanceId, created.id).pipe(
        Effect.flatMap((credential) => use(toRedacted(credential.uri))),
      ),
    (credential) =>
      credentialApi
        .deleteCredential(scope, instanceId, credential.id)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `Could not delete migration credential ${credential.id} of ${instanceId}: ${error._tag}`,
            ),
          ),
        ),
  );

/**
 * Apply pending migrations over a direct `mysql2` connection, the only way in: the
 * API has no SQL endpoint. Connecting is what needs the deployer's IP in the
 * instance's ACL. The connection settings, TLS included, are whatever the URI the
 * API hands out says. A credential is only created when there are files to apply.
 */
export const runInstanceMigrations = (options: {
  readonly scope: ProjectScope;
  readonly instanceId: string;
  readonly instanceName: string;
  readonly input: NormalizedMigrationsInput;
  readonly stamped: StampedMigrationsState;
}) =>
  runMigrations({
    input: options.input,
    stamped: options.stamped,
    withExecutor: (apply) =>
      withRunCredential(options.scope, options.instanceId, (uri) =>
        withMySqlExecutor(
          {
            uri: Redacted.value(uri),
            multipleStatements: true,
            connectTimeout: CONNECT_TIMEOUT_MILLIS,
          },
          (executor) => probeExecutor(executor).pipe(Effect.flatMap(apply)),
          {
            // A new ACL or credential can take a moment to apply. Bounded to a few
            // minutes at worst, since each attempt can use up its connect timeout.
            retryConnect: {
              while: (cause) => isNetworkFailure(cause) || isLoginFailure(cause),
              times: 8,
              interval: "5 seconds",
            },
            onConnectFailure: (error) =>
              isNetworkFailure(error.cause)
                ? new MigrationError({
                    message:
                      `${error.message} — STACKIT MariaDB only accepts connections from the ` +
                      `instance's ACL. Add this machine's public IP as a /32 to the acl of ` +
                      `instance '${options.instanceName}'.`,
                    cause: error.cause,
                  })
                : error,
          },
        ),
      ),
  });
