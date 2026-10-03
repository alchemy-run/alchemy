import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isClusterOwned } from "../ContainerService/Common.ts";

export class InvalidClusterId extends Data.TaggedError(
  "Azure.KubernetesConfiguration.InvalidClusterId",
)<{
  readonly clusterId: string;
  readonly message: string;
}> {}

/** Path parameters of a cluster that hosts extensions and Flux configurations. */
export interface ClusterRef {
  readonly resourceGroupName: string;
  /** Resource provider, e.g. `Microsoft.ContainerService`. */
  readonly clusterRp: string;
  /** Resource type, e.g. `managedClusters` or `connectedClusters`. */
  readonly clusterResourceName: string;
  readonly clusterName: string;
}

const CLUSTER_ID =
  /^\/subscriptions\/[^/]+\/resourceGroups\/([^/]+)\/providers\/([^/]+)\/([^/]+)\/([^/]+)\/?$/i;

/**
 * Split a cluster ARM ID (AKS managed cluster, Arc connected cluster, or
 * hybrid provisioned cluster) into the path parameters the
 * Microsoft.KubernetesConfiguration API expects.
 */
export const parseClusterId = (clusterId: string) =>
  Effect.suspend(() => {
    const match = CLUSTER_ID.exec(clusterId);
    if (match === null) {
      return Effect.fail(
        new InvalidClusterId({
          clusterId,
          message: `'${clusterId}' is not a cluster resource ID (/subscriptions/{id}/resourceGroups/{rg}/providers/{rp}/{type}/{name})`,
        }),
      );
    }
    return Effect.succeed<ClusterRef>({
      resourceGroupName: match[1]!,
      clusterRp: match[2]!,
      clusterResourceName: match[3]!,
      clusterName: match[4]!,
    });
  });

/**
 * Extensions and Flux configurations cannot be tagged; ownership follows the
 * hosting AKS cluster's Alchemy tags. Clusters of other types (Arc,
 * hybrid) are never considered owned.
 */
export const isHostOwned = Effect.fn(function* (
  subscriptionId: string,
  ref: ClusterRef,
) {
  if (
    ref.clusterRp.toLowerCase() !== "microsoft.containerservice" ||
    ref.clusterResourceName.toLowerCase() !== "managedclusters"
  ) {
    return false;
  }
  return yield* isClusterOwned(
    subscriptionId,
    ref.resourceGroupName,
    ref.clusterName,
  );
});

/** Reveal a possibly redacted secret value. */
export const reveal = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/** Reveal every value of a secret settings map. */
export const revealMap = (
  settings: Record<string, string | Redacted.Redacted<string>> | undefined,
): Record<string, string> | undefined =>
  settings === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(settings).map(([key, value]) => [key, reveal(value)]),
      );

/** Whether two secret settings maps hold the same revealed values. */
export const sameSecrets = (
  a: Record<string, string | Redacted.Redacted<string>> | undefined,
  b: Record<string, string | Redacted.Redacted<string>> | undefined,
) => {
  const left = revealMap(a) ?? {};
  const right = revealMap(b) ?? {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
};
