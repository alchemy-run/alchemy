import type { AzureOpError } from "@distilled.cloud/azure";
import * as resources from "@distilled.cloud/azure/resources";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  stripInternalTags,
  tagRecord,
} from "../Tags.ts";

/**
 * Typed tags distilled Azure returns for a missing resource: ARM's
 * `ResourceNotFound` / `ResourceGroupNotFound`, resource-provider codes
 * (`RoleAssignmentNotFound`, `ContainerNotFound`, `ShareNotFound`, ...), and the HTTP 404
 * fallback for provider codes the SDK does not map yet. A 403 is never
 * "gone".
 */
export const NOT_FOUND_TAGS = [
  "ResourceNotFound",
  "ResourceGroupNotFound",
  "RoleAssignmentNotFound",
  "ContainerNotFound",
  "ShareNotFound",
  "QueueNotFound",
  "ManagementPolicyNotFound",
  "BlobInventoryPolicyNotFound",
  "AdvancedPlatformMetricsRuleNotFound",
  "ObjectReplicationPolicyNotFound",
  "ApiManagementServiceNotFound",
  "NotFound",
] as const;

/**
 * Map a not-found failure of an Azure operation to `undefined`.
 *
 * `MissingRegistration` also means "absent": a subscription that has not
 * registered a resource provider namespace cannot hold resources of it
 * (Azure refuses to unregister a namespace that still has resources).
 */
export const orUndefinedIfNotFound = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E | AzureOpError, R>,
) =>
  Effect.catchTag(effect, [...NOT_FOUND_TAGS, "MissingRegistration"], () =>
    Effect.succeed(undefined),
  );

/** Namespaces already confirmed registered, keyed by `subscription/namespace`. */
const registered = new Set<string>();

export class RegistrationTimedOut extends Data.TaggedError(
  "Azure.RegistrationTimedOut",
)<{
  readonly namespace: string;
  readonly state: string | undefined;
  readonly message: string;
}> {}

/**
 * Register a resource provider namespace (e.g. `Microsoft.Storage`) on the
 * subscription if it is not registered yet, and wait until it is. New
 * subscriptions only register a handful of namespaces; ARM rejects the rest
 * with `MissingRegistration`. Checked once per namespace per process.
 */
export const ensureRegistered = (subscriptionId: string, namespace: string) =>
  Effect.gen(function* () {
    const key = `${subscriptionId}/${namespace.toLowerCase()}`;
    if (yield* Effect.sync(() => registered.has(key))) return;
    const request = { subscriptionId, resourceProviderNamespace: namespace };
    // A read on every reconcile: retry the occasional truncated response.
    const getProvider = resources
      .GetProvider(request)
      .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 3 }));
    const current = yield* getProvider;
    if (current.registrationState !== "Registered") {
      if (current.registrationState !== "Registering") {
        yield* resources.RegisterProvider(request);
      }
      const final = yield* getProvider.pipe(
        Effect.repeat({
          until: (provider) => provider.registrationState === "Registered",
          schedule: Schedule.spaced("5 seconds"),
          times: 36,
        }),
      );
      if (final.registrationState !== "Registered") {
        return yield* new RegistrationTimedOut({
          namespace,
          state: final.registrationState,
          message: `Resource provider ${namespace} is still '${final.registrationState}' after 3 minutes`,
        });
      }
    }
    yield* Effect.sync(() => registered.add(key));
  });

/** Ignore a not-found failure of an Azure operation (idempotent deletes). */
export const ignoreNotFound = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E | AzureOpError, R>,
) => Effect.asVoid(orUndefinedIfNotFound(effect));

export class ProvisioningFailed extends Data.TaggedError(
  "Azure.ProvisioningFailed",
)<{
  readonly resource: string;
  readonly state: string;
  readonly message: string;
}> {}

export class ProvisioningTimedOut extends Data.TaggedError(
  "Azure.ProvisioningTimedOut",
)<{
  readonly resource: string;
  readonly state: string | undefined;
  readonly message: string;
}> {}

export class DeleteTimedOut extends Data.TaggedError("Azure.DeleteTimedOut")<{
  readonly resource: string;
  readonly message: string;
}> {}

export class ListIncomplete extends Data.TaggedError("Azure.ListIncomplete")<{
  readonly operation: string;
  readonly message: string;
}> {}

const TERMINAL_FAILURES = new Set(["Failed", "Canceled", "Cancelled"]);

export interface WaitBudget {
  /** Poll interval. @default 3 seconds */
  readonly interval?: `${number} seconds`;
  /** Number of polls before giving up. @default 40 */
  readonly times?: number;
}

/**
 * Poll `get` until the resource reports `provisioningState: "Succeeded"`.
 *
 * ARM create/update calls are long-running operations: the PUT returns
 * `201`/`202` (sometimes with an empty body) and the resource converges in
 * the background. A resource that has no `provisioningState` is ready once
 * it is readable. A `404` right after the PUT is eventual consistency and
 * keeps polling. `Failed`/`Canceled` fail fast.
 */
export const waitForProvisioned = <A, E, R>(
  resource: string,
  get: Effect.Effect<A | undefined, E, R>,
  stateOf: (value: A) => string | undefined,
  budget: WaitBudget = {},
) =>
  Effect.gen(function* () {
    const times = budget.times ?? 40;
    let last: string | undefined;
    const poll = get.pipe(
      Effect.flatMap(
        (value): Effect.Effect<A, "pending" | ProvisioningFailed> => {
          if (value === undefined) return Effect.fail("pending" as const);
          const state = stateOf(value);
          last = state;
          if (state === undefined || state === "Succeeded") {
            return Effect.succeed(value);
          }
          if (TERMINAL_FAILURES.has(state)) {
            return Effect.fail(
              new ProvisioningFailed({
                resource,
                state,
                message: `${resource} provisioning ended in state '${state}'`,
              }),
            );
          }
          return Effect.fail("pending" as const);
        },
      ),
    );
    return yield* poll.pipe(
      Effect.retry({
        while: (e) => e === "pending",
        schedule: Schedule.spaced(budget.interval ?? "3 seconds"),
        times,
      }),
      Effect.catchIf(
        (e): e is "pending" => e === "pending",
        () =>
          Effect.fail(
            new ProvisioningTimedOut({
              resource,
              state: last,
              message: `${resource} did not reach 'Succeeded' after ${times} polls (last state: ${last ?? "not found"})`,
            }),
          ),
      ),
    );
  });

/**
 * Poll `get` until it reports the resource is gone (`undefined`). ARM
 * deletes are long-running operations that return `202 Accepted`.
 */
export const waitUntilGone = <A, E, R>(
  resource: string,
  get: Effect.Effect<A | undefined, E, R>,
  budget: WaitBudget = {},
) => {
  const times = budget.times ?? 40;
  return get.pipe(
    Effect.flatMap((value) =>
      value === undefined ? Effect.void : Effect.fail("present" as const),
    ),
    Effect.retry({
      while: (e) => e === "present",
      schedule: Schedule.spaced(budget.interval ?? "3 seconds"),
      times,
    }),
    Effect.catchIf(
      (e): e is "present" => e === "present",
      () =>
        Effect.fail(
          new DeleteTimedOut({
            resource,
            message: `${resource} still exists after ${times} polls`,
          }),
        ),
    ),
  );
};

/**
 * Fail loudly when an ARM list returns more than one page. Distilled Azure
 * does not follow `nextLink` yet, and a silently truncated list would hide
 * leaked resources from `alchemy unsafe nuke`.
 */
export const requireSinglePage = <T extends { nextLink?: string }>(
  operation: string,
  page: T,
) =>
  page.nextLink
    ? Effect.fail(
        new ListIncomplete({
          operation,
          message: `${operation} returned more than one page; paging via nextLink is not supported yet`,
        }),
      )
    : Effect.succeed(page);

/**
 * Desired Azure tags: the user's tags plus the Alchemy ownership tags
 * (`alchemy::stack`, `alchemy::stage`, `alchemy::id`). Azure tag names may
 * contain `:`, so the internal tags are used verbatim.
 */
export const desiredTags = Effect.fn(function* (
  id: string,
  tags: Record<string, string> | undefined,
) {
  return { ...tags, ...(yield* createInternalTags(id)) };
});

/** Whether observed tags carry this stack/stage/id's ownership tags. */
export const isOwned = (
  id: string,
  tags: Record<string, string | undefined> | undefined,
) => hasAlchemyTags(id, tagRecord(tags));

/** User-facing tags (ownership tags stripped). */
export const userTags = (
  tags: Record<string, string | undefined> | undefined,
): Record<string, string> => stripInternalTags(tagRecord(tags));

/**
 * True when the observed tags differ from the desired tags. ARM replaces
 * the whole tag map on PUT/PATCH, so any delta means one full write.
 */
export const tagsDiffer = (
  observed: Record<string, string | undefined> | undefined,
  desired: Record<string, string>,
) => {
  const { removed, upsert } = diffTags(tagRecord(observed), desired);
  return removed.length > 0 || upsert.length > 0;
};

/**
 * ARM `$filter` selecting resources Alchemy tagged for the current stack.
 * Only resource-group and generic-resource lists support tag filters.
 */
export const stackTagFilter = Effect.gen(function* () {
  const stack = yield* Stack;
  return `tagName eq 'alchemy::stack' and tagValue eq '${stack.name.replaceAll("'", "''")}'`;
});

/** Whether tags carry any Alchemy ownership tag (used by `list`). */
export const hasAnyAlchemyTag = (
  tags: Record<string, string | undefined> | undefined,
) => tags !== undefined && "alchemy::stack" in tags;

/** The current stack and stage, e.g. for ownership markers without tags. */
export const stackAndStage = Effect.gen(function* () {
  return { stack: (yield* Stack).name, stage: yield* Stage };
});

/** Resource group name from an ARM resource ID, e.g. for `list` results. */
export const resourceGroupOf = (armId: string | undefined) =>
  armId?.match(/\/resourceGroups\/([^/]+)/i)?.[1];
