/**
 * Shared lifecycle helpers of `Stackit.ModelExperiments`. Not exported from the namespace barrel.
 */
import * as modelExperiments from "@distilled.cloud/stackit/model_experiments";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { ProjectScope } from "../IaaS/internal.ts";

/** Service enablement id, from the spec's `x-stackit-authorization`. */
export const MODEL_EXPERIMENTS_SERVICE_ID = "cloud.stackit.model-experiments";

/** Instance and token budget (the Go SDK's wait handlers, 45 minutes). */
export const LIFECYCLE_TIMEOUT = "45 minutes";

/** The API's limit on a name. */
export const NAME_MAX_LENGTH = 64;

/**
 * The spec answers 409 on a PATCH or DELETE while an instance or token is in a transition. Bounded
 * to about a minute.
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

/** An instance, or `undefined` once it is gone. */
export const getInstanceOrUndefined = (scope: ProjectScope, instanceId: string) =>
  modelExperiments.getInstance({ ...scopeRequest(scope), instanceId }).pipe(
    Effect.map(({ instance }) => instance),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** The live instances of a scope. The API doesn't page this list. */
export const listScopeInstances = (scope: ProjectScope) =>
  modelExperiments
    .listInstances(scopeRequest(scope))
    .pipe(
      Effect.map(({ instances }) => instances.filter((instance) => instance.state !== "deleting")),
    );
