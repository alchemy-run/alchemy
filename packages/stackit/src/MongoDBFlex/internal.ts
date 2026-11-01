/**
 * Shared scaffolding for the STACKIT MongoDB Flex resources. Not exported from
 * the namespace barrel.
 */
import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isGeneratedPhysicalName } from "../internal/names.ts";

/** Where a MongoDB Flex object lives: every API path carries both. */
export interface MongoScope {
  projectId: string;
  region: string;
}

/** Instance create and update budget (the SDK's wait handlers). */
export const INSTANCE_TIMEOUT = "45 minutes";

/** Instance delete budget (the SDK's `DeleteInstanceWaitHandler`). */
export const INSTANCE_DELETE_TIMEOUT = "15 minutes";

/**
 * How long a user change may take to show. Users have no status field to wait on,
 * and the SDK has no handler for them.
 */
export const SETTLE_TIMEOUT = "5 minutes";

/** Instance and user names are at most 63 characters (the spec's `maxLength`). */
const MAX_NAME_LENGTH = 63;

/**
 * The API answered 2xx without a field its spec leaves optional and nothing can go
 * on without, such as the id of what it just created.
 */
export class ResponseIncomplete extends Data.TaggedError("Stackit.MongoDBFlex.ResponseIncomplete")<{
  readonly operation: string;
  readonly field: string;
  readonly message: string;
}> {}

const incomplete = (operation: string, field: string) =>
  new ResponseIncomplete({
    operation,
    field,
    message: `STACKIT MongoDB Flex ${operation} answered without ${field}`,
  });

/** An instance as the API reports it, with the identity the rest relies on. */
export type ObservedInstance = mongodb.Instance & {
  readonly id: string;
  readonly name: string;
};

/** A user as the API reports it, with the identity the rest relies on. */
export type ObservedUser = mongodb.InstanceResponseUser & {
  readonly id: string;
  readonly username: string;
};

/** `GetInstance`. Keeps the typed `NotFound`, for a caller waiting on a live instance. */
export const getInstance = (scope: MongoScope, instanceId: string) =>
  Effect.gen(function* () {
    const { item } = yield* mongodb.getInstance({ ...scope, instanceId });
    if (item?.id === undefined) return yield* incomplete("getInstance", "item.id");
    if (item.name === undefined) return yield* incomplete("getInstance", "item.name");
    const instance: ObservedInstance = { ...item, id: item.id, name: item.name };
    return instance;
  });

/** `GetInstance`; `undefined` once the instance is gone. */
export const getInstanceOrUndefined = (scope: MongoScope, instanceId: string) =>
  getInstance(scope, instanceId).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/**
 * Every instance of a project in a region, in the list's short shape.
 *
 * `tag` is required by the spec and undocumented ("instance tag"). STACKIT's Terraform
 * acceptance test lists everything with an empty one, so this does too. The list takes
 * no paging parameters.
 */
export const listInstanceSummaries = (scope: MongoScope) =>
  mongodb.listInstances({ ...scope, tag: "" }).pipe(Effect.map(({ items }) => items ?? []));

/**
 * Every instance of a project and region with a generated name, in full.
 *
 * Instances have no labels to read back, so the name's shape is all `list` has. That is
 * a match, not proof of ownership: see `isGeneratedPhysicalName`.
 */
export const listGeneratedInstances = (scope: MongoScope) =>
  Effect.gen(function* () {
    const summaries = yield* listInstanceSummaries(scope);
    const instances: ObservedInstance[] = [];
    for (const summary of summaries) {
      if (summary.id === undefined || summary.name === undefined) continue;
      if (!isGeneratedInstanceName(summary.name)) continue;
      const instance = yield* getInstanceOrUndefined(scope, summary.id);
      if (instance !== undefined) instances.push(instance);
    }
    return instances;
  });

/** `GetUser`, with the identity checked; `undefined` once the user is gone. */
export const getUserOrUndefined = (scope: MongoScope, instanceId: string, userId: string) =>
  Effect.gen(function* () {
    const { item } = yield* mongodb.getUser({ ...scope, instanceId, userId });
    if (item?.id === undefined) return yield* incomplete("getUser", "item.id");
    if (item.username === undefined) return yield* incomplete("getUser", "item.username");
    const user: ObservedUser = { ...item, id: item.id, username: item.username };
    return user;
  }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** The id a create answered with, or {@link ResponseIncomplete}. */
export const requireId = (
  operation: string,
  id: string | undefined,
): Effect.Effect<string, ResponseIncomplete> =>
  id === undefined ? Effect.fail(incomplete(operation, "id")) : Effect.succeed(id);

/** A value from the API or a binding, always `Redacted`. */
export const toRedacted = (
  value: string | Redacted.Redacted<string> | undefined,
): Redacted.Redacted<string> | undefined =>
  typeof value === "string" ? Redacted.make(value) : value;

/**
 * A generated instance name. The spec's pattern takes a letter or `_` first, so a stack
 * name starting with a digit gets a `_`.
 */
export const generatedInstanceName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: MAX_NAME_LENGTH - 1 }).pipe(
    Effect.map((name) => (/^[a-z_]/.test(name) ? name : `_${name}`)),
  );

/** Whether an instance name has the shape {@link generatedInstanceName} gives it. */
export const isGeneratedInstanceName = (name: string): boolean =>
  isGeneratedPhysicalName(name.replace(/^_/, ""), MAX_NAME_LENGTH - 1);

/**
 * A generated user name. The spec's pattern takes a letter first and no `_`, so a stack
 * name starting with a digit gets a `u`.
 */
export const generatedUserName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: MAX_NAME_LENGTH - 1 }).pipe(
    Effect.map((name) => (/^[a-z]/.test(name) ? name : `u${name}`)),
  );

/** Whether a user name has the shape {@link generatedUserName} gives it. */
export const isGeneratedUserName = (name: string): boolean =>
  isGeneratedPhysicalName(name.replace(/^u(?=\d)/, ""), MAX_NAME_LENGTH - 1);
