/**
 * Shared lifecycle helpers of `Stackit.Logs`. Not exported from the namespace barrel.
 */
import * as logs from "@distilled.cloud/stackit/logs";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { ProjectScope } from "../IaaS/internal.ts";
import {
  hasAlchemyLabels,
  hasInstanceLabel,
  managedLabels,
  stripInternalLabels,
} from "../Labels.ts";

/** Service enablement id, from the spec's `x-stackit-authorization`. */
export const LOGS_SERVICE_ID = "cloud.stackit.logs";

/** Instance create and delete budget (the Go SDK's wait handlers, 10 minutes). */
export const INSTANCE_TIMEOUT = "10 minutes";

/** The API's limit on `displayName`. */
const DISPLAY_NAME_MAX_LENGTH = 32;

/**
 * The spec's description of a 409 on these APIs: "The resource has been modified by
 * some other client. Please try again." Bounded to a minute. A create isn't retried: an
 * access policy's 409 means the email already has one.
 */
export const conflictRetry = {
  while: (error: { readonly _tag: string }) => error._tag === "Conflict",
  schedule: Schedule.spaced("5 seconds"),
  times: 12,
} as const;

/** A scope as a request's path parameters. */
export const scopeRequest = (scope: ProjectScope) => ({
  projectId: scope.projectId,
  regionId: scope.region,
});

/**
 * A generated `displayName`. The API requires an initial letter, and a stack's name
 * can start with a digit.
 */
export const generatedDisplayName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: DISPLAY_NAME_MAX_LENGTH });
  return /^[a-zA-Z]/.test(name) ? name : `x${name}`.slice(0, DISPLAY_NAME_MAX_LENGTH);
});

/** The labels a user set: neither STACKIT's nor Alchemy's. */
export const userLabels = (labels: unknown): Record<string, string> =>
  stripInternalLabels(managedLabels(labels));

/** The first item labelled as this logical id, and as `generation` when one is given. */
export const findOwned = <A extends { readonly labels?: unknown }>(
  id: string,
  items: ReadonlyArray<A>,
  generation: string | undefined,
) =>
  Effect.gen(function* () {
    for (const item of items) {
      if (
        (yield* hasAlchemyLabels(id, item.labels)) &&
        (generation === undefined || hasInstanceLabel(generation, item.labels))
      ) {
        return item;
      }
    }
    return undefined;
  });

/** A live instance, or `undefined` when it is gone or going. */
export const getInstanceOrUndefined = (scope: ProjectScope, instanceId: string) =>
  logs.getLogsInstance({ ...scopeRequest(scope), instanceId }).pipe(
    Effect.map((instance) => (instance.status === "deleting" ? undefined : instance)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** The live instances of a scope. The API doesn't page this list. */
export const listInstances = (scope: ProjectScope) =>
  logs
    .listLogsInstances(scopeRequest(scope))
    .pipe(
      Effect.map(({ instances }) => instances.filter((instance) => instance.status !== "deleting")),
    );

export const toRedacted = (value: string | Redacted.Redacted<string>): Redacted.Redacted<string> =>
  typeof value === "string" ? Redacted.make(value) : value;
