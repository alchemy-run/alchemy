import * as hdinsight from "@distilled.cloud/azure/hdinsight";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Observe an HDInsight cluster; `undefined` when it does not exist. */
export const getCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) =>
  orUndefinedIfNotFound(
    hdinsight.GetCluster({ subscriptionId, resourceGroupName, clusterName }),
  );

/**
 * Cluster extensions carry no tags. They count as owned when their parent
 * cluster carries this stack's and stage's ownership tags.
 */
export const clusterOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) {
  const observed = yield* getCluster(
    subscriptionId,
    resourceGroupName,
    clusterName,
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    observed?.tags?.["alchemy::stack"] === stack &&
    observed?.tags?.["alchemy::stage"] === stage
  );
});

/** Plain value of a secret given either redacted or as a string. */
export const reveal = (
  value: Redacted.Redacted<string> | string | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

export const lower = (value: string | undefined) => value?.toLowerCase();

/** ARM may report locations by display name (`East US`). */
export const normalizeLocation = (value: string | undefined) =>
  value?.replace(/\s+/g, "").toLowerCase();

/**
 * Canonical JSON (sorted keys, `null` fields dropped) for comparing nested
 * structures whose key order Azure does not preserve.
 */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined && entry !== null)
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  ) ?? "undefined";
