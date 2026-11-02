/**
 * Shared scaffolding for the STACKIT SQL Server Flex resources. Not exported
 * from the namespace barrel.
 */
import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isAlchemyOwned } from "../Labels.ts";
import { collectPages } from "../PostgresFlex/internal.ts";

export {
  collectPages,
  generatedIdentifier,
  isGeneratedIdentifier,
  toRedacted,
} from "../PostgresFlex/internal.ts";

/** Where a SQL Server Flex object lives: every API path carries both. */
export interface SqlServerScope {
  projectId: string;
  region: string;
}

/** Instance create and update budget (the SDK's wait handlers). */
export const INSTANCE_TIMEOUT = "45 minutes";

/** Instance delete budget (the SDK's `DeleteInstanceWaitHandler`). */
export const INSTANCE_DELETE_TIMEOUT = "15 minutes";

/** User create budget (the SDK's `CreateUserWaitHandler`). */
export const USER_TIMEOUT = "15 minutes";

/**
 * How long a database or a deleted user may take to show its new state. A database
 * has no state field to wait on, and the SDK has no handler for databases.
 */
export const SETTLE_TIMEOUT = "5 minutes";

/**
 * The instance answers 423 or 425 while it can't take the call yet. The Terraform
 * provider retries both on creating and deleting users and databases, because an
 * instance in maintenance mode clears by itself. Bounded to under a minute.
 */
export const instanceBusyRetry = {
  while: (error: { readonly _tag: string }) =>
    error._tag === "InstanceLocked" || error._tag === "InstanceNotReady",
  schedule: Schedule.spaced("5 seconds"),
  times: 10,
} as const;

/** `GetInstance`; `undefined` once the instance is gone. */
export const getInstanceOrUndefined = (scope: SqlServerScope, instanceId: string) =>
  sqlserver
    .getInstance({ ...scope, instanceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Every instance of a project in a region, in the list's short shape (no labels). */
export const listInstanceSummaries = (scope: SqlServerScope) =>
  collectPages(
    (page) => sqlserver.listInstances({ ...scope, page }),
    (response) => response.instances,
  );

/** Every instance Alchemy created in a project and region, in full. */
export const listOwnedInstances = (scope: SqlServerScope) =>
  Effect.gen(function* () {
    const summaries = yield* listInstanceSummaries(scope);
    const owned: sqlserver.GetInstanceResponse[] = [];
    for (const summary of summaries) {
      if (summary.state === "TERMINATING") continue;
      const instance = yield* getInstanceOrUndefined(scope, summary.id);
      if (instance !== undefined && isAlchemyOwned(instance.labels)) owned.push(instance);
    }
    return owned;
  });

/** Every user of an instance, in the list's short shape. */
export const listUserSummaries = (scope: SqlServerScope, instanceId: string) =>
  collectPages(
    (page) => sqlserver.listUsers({ ...scope, instanceId, page }),
    (response) => response.users,
  );

/** The `{…}` form of a connection-string value, which may hold `;` or `=`. */
const connectionStringValue = (value: string) => `{${value.replaceAll("}", "}}")}}`;

/** An ADO-style connection string. TLS is always on. */
export const connectionString = (options: {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}): string =>
  [
    `Server=${options.host},${options.port}`,
    `Database=${connectionStringValue(options.database)}`,
    `User Id=${connectionStringValue(options.username)}`,
    `Password=${connectionStringValue(options.password)}`,
    "Encrypt=true",
  ].join(";");
