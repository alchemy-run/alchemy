/**
 * Shared scaffolding for the STACKIT PostgreSQL Flex resources. Not exported
 * from the namespace barrel.
 */
import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import { isAlchemyOwned } from "../Labels.ts";

/** Where a PostgreSQL Flex object lives: every API path carries both. */
export interface PostgresScope {
  projectId: string;
  region: string;
}

/** Instance create, update and delete budget (the Terraform provider's 45 minutes). */
export const INSTANCE_TIMEOUT = "45 minutes";

/** User create budget (the SDK's `CreateUserWaitHandler`). */
export const USER_TIMEOUT = "15 minutes";

/**
 * How long a database or a deleted user may take to show its new state. Neither
 * has a state field to wait on, and the SDK has no handler for databases.
 */
export const SETTLE_TIMEOUT = "5 minutes";

/** Database and user names are at most 63 characters (the PostgreSQL limit). */
const MAX_NAME_LENGTH = 63;

/**
 * The spec's 423 ("the instance is not yet ready to perform this operation")
 * clears by itself. The Terraform provider retries it on every user and database
 * write. Bounded to under a minute.
 */
export const instanceLockedRetry = {
  while: (error: { readonly _tag: string }) => error._tag === "InstanceLocked",
  schedule: Schedule.spaced("5 seconds"),
  times: 10,
} as const;

/**
 * {@link instanceLockedRetry}, plus the 409 a delete answers while it can't go
 * ahead yet: active sessions on a database, or a user still owning a database
 * that is being dropped.
 */
export const deleteBlockedRetry = {
  while: (error: { readonly _tag: string }) =>
    error._tag === "InstanceLocked" || error._tag === "Conflict",
  schedule: Schedule.spaced("5 seconds"),
  times: 10,
} as const;

/**
 * Fetch every page of a list. PostgreSQL Flex answers `pagination` with a
 * `totalPages` nested in the body, which distilled's paginator doesn't read.
 */
export const collectPages = <P extends { readonly pagination: postgres.Pagination }, A, E, R>(
  fetchPage: (page: number) => Effect.Effect<P, E, R>,
  itemsOf: (page: P) => ReadonlyArray<A>,
): Effect.Effect<A[], E, R> =>
  Effect.gen(function* () {
    const items: A[] = [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const response = yield* fetchPage(page);
      items.push(...itemsOf(response));
      totalPages = response.pagination.totalPages;
      page++;
    }
    return items;
  });

/** `GetInstance`; `undefined` once the instance is gone. */
export const getInstanceOrUndefined = (scope: PostgresScope, instanceId: string) =>
  postgres
    .getInstance({ ...scope, instanceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Every instance of a project in a region, in the list's short shape (no labels). */
export const listInstanceSummaries = (scope: PostgresScope) =>
  collectPages(
    (page) => postgres.listInstances({ ...scope, page }),
    (response) => response.instances,
  );

/** Every instance Alchemy created in a project and region, in full. */
export const listOwnedInstances = (scope: PostgresScope) =>
  Effect.gen(function* () {
    const summaries = yield* listInstanceSummaries(scope);
    const owned: postgres.GetInstanceResponse[] = [];
    for (const summary of summaries) {
      if (summary.state === "TERMINATING") continue;
      const instance = yield* getInstanceOrUndefined(scope, summary.id);
      if (instance !== undefined && isAlchemyOwned(instance.labels)) owned.push(instance);
    }
    return owned;
  });

/** A password from the API or the environment, always `Redacted`. */
export const toRedacted = (value: string | Redacted.Redacted<string>): Redacted.Redacted<string> =>
  typeof value === "string" ? Redacted.make(value) : value;

/**
 * A generated database or user name, usable as an unquoted PostgreSQL
 * identifier. Hyphens in a stack name become underscores, and a name can't start
 * with a digit.
 */
export const generatedIdentifier = (id: string) =>
  createPhysicalName({
    id,
    lowercase: true,
    delimiter: "_",
    maxLength: MAX_NAME_LENGTH - 1,
  }).pipe(
    Effect.map((name) => {
      const identifier = name.replaceAll("-", "_");
      return /^[a-z_]/.test(identifier) ? identifier : `_${identifier}`;
    }),
  );

/** Whether a database or user name has the shape {@link generatedIdentifier} gives it. */
export const isGeneratedIdentifier = (name: string): boolean =>
  // The shape check counts hyphens, which the identifier turned into underscores.
  isGeneratedPhysicalName(name.replace(/^_/, "").replaceAll("_", "-"), MAX_NAME_LENGTH - 1);

/** A `postgresql://` URL. TLS is the only way in, so it always asks for it. */
export const connectionUrl = (options: {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: Redacted.Redacted<string>;
}): Redacted.Redacted<string> =>
  Redacted.make(
    `postgresql://${encodeURIComponent(options.username)}:${encodeURIComponent(
      options.password.pipe(Redacted.value),
    )}@${options.host}:${options.port}/${encodeURIComponent(options.database)}?sslmode=require`,
  );
