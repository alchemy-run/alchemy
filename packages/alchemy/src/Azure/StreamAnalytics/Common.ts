import * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/**
 * Name for a streaming job, cluster, or job child (input, output, function):
 * 3-63 letters, digits, hyphens, and underscores, starting and ending with a
 * letter or digit.
 */
export const createStreamAnalyticsName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 63 });
  return name.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
});

/** Observe a streaming job; `undefined` when it does not exist. */
export const getStreamingJob = (
  subscriptionId: string,
  resourceGroupName: string,
  jobName: string,
) =>
  orUndefinedIfNotFound(
    streamanalytics.GetStreamingJob({
      subscriptionId,
      resourceGroupName,
      jobName,
    }),
  );

/** Observe a Stream Analytics cluster; `undefined` when it does not exist. */
export const getCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) =>
  orUndefinedIfNotFound(
    streamanalytics.GetCluster({
      subscriptionId,
      resourceGroupName,
      clusterName,
    }),
  );

const ownedByStage = Effect.fn(function* (
  tags: Record<string, string | undefined> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  return (
    tags?.["alchemy::stack"] === stack && tags?.["alchemy::stage"] === stage
  );
});

/**
 * Job children (inputs, outputs, functions, the transformation) carry no
 * tags. They count as owned when their streaming job carries this stack's
 * and stage's ownership tags.
 */
export const jobOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  jobName: string,
) {
  const job = yield* getStreamingJob(
    subscriptionId,
    resourceGroupName,
    jobName,
  );
  return yield* ownedByStage(job?.tags);
});

/** Cluster private endpoints count as owned when their cluster is. */
export const clusterOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) {
  const cluster = yield* getCluster(
    subscriptionId,
    resourceGroupName,
    clusterName,
  );
  return yield* ownedByStage(cluster?.tags);
});

/**
 * Write-only secrets Stream Analytics never returns on GET (storage account
 * keys, SAS keys, passwords). They are excluded from observed-state
 * comparison; a change is detected against the previous props instead.
 */
const SECRET_KEYS = new Set([
  "accountKey",
  "sharedAccessPolicyKey",
  "sharedAccessKey",
  "password",
  "apiKey",
  "sasKey",
]);

/**
 * True when every value set in `desired` equals the observed value
 * (recursively, strings compared case-insensitively). Keys left `undefined`
 * in `desired` and write-only secrets are not compared.
 */
export const matchesObserved = (
  desired: unknown,
  observed: unknown,
): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((value, i) => matchesObserved(value, observed[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(
      ([key, value]) =>
        SECRET_KEYS.has(key) ||
        matchesObserved(value, (observed as Record<string, unknown>)[key]),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return desired === observed;
};

/** Stable JSON (sorted keys) for comparing previous and desired props. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );

/** Strip write-only secrets from an observed/desired document. */
export const withoutSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SECRET_KEYS.has(key))
        .map(([key, v]) => [key, withoutSecrets(v)]),
    );
  }
  return value;
};

/** Polymorphic `{ type, properties }` document (data source, serialization, binding). */
export interface TypedDocument {
  /**
   * Discriminator, e.g. `Microsoft.Storage/Blob`, `Json`,
   * `Microsoft.StreamAnalytics/JavascriptUdf`.
   */
  type: string;
  /** Type-specific properties. */
  properties?: Record<string, unknown>;
}

export const lower = (value: string | undefined) =>
  value?.toLowerCase().replace(/\s/g, "");

export class ResourceGroupNameTooLong extends Data.TaggedError(
  "Azure.StreamAnalytics.ResourceGroupNameTooLong",
)<{
  readonly resourceGroup: string;
  readonly message: string;
}> {}

/**
 * Stream Analytics rejects any request under a resource group whose name
 * is longer than 80 characters with a 404 "HTTP Request has an invalid
 * URL", even though ARM allows 90. Fail with a clear error instead.
 */
export const MAX_RESOURCE_GROUP_LENGTH = 80;

export const checkResourceGroup = (resourceGroup: string) =>
  resourceGroup.length > MAX_RESOURCE_GROUP_LENGTH
    ? Effect.fail(
        new ResourceGroupNameTooLong({
          resourceGroup,
          message: `Stream Analytics only supports resource group names up to ${MAX_RESOURCE_GROUP_LENGTH} characters; '${resourceGroup}' has ${resourceGroup.length}`,
        }),
      )
    : Effect.void;
