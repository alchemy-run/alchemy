import * as cs from "@distilled.cloud/azure/containerservice";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  resourceGroupOf,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isClusterOwned, sameName, whileClusterBusy } from "./Common.ts";

export type DeploymentSafeguardsLevel = cs.DeploymentSafeguardsLevel;
export type PodSecurityStandardsLevel = cs.PodSecurityStandardsLevel;

export interface DeploymentSafeguardProps {
  /**
   * ARM resource ID of the managed cluster. Changing it replaces the
   * safeguard.
   */
  clusterId: string;
  /**
   * `Warn` reports non-compliant deployments; `Enforce` rejects them.
   */
  level: DeploymentSafeguardsLevel;
  /** Namespaces excluded from the safeguards. */
  excludedNamespaces?: string[];
  /**
   * Pod Security Standards level enforced on top of the safeguards
   * (`Privileged`, `Baseline`, `Restricted`).
   */
  podSecurityStandardsLevel?: PodSecurityStandardsLevel;
}

export interface DeploymentSafeguard extends Resource<
  "Azure.ContainerService.DeploymentSafeguard",
  DeploymentSafeguardProps,
  {
    /** ARM resource ID of the safeguard (`{clusterId}/providers/.../default`). */
    safeguardId: string;
    /** ARM resource ID of the managed cluster. */
    clusterId: string;
    /** Observed level. */
    level: string;
    /** Observed user-excluded namespaces. */
    excludedNamespaces: string[];
    /** Namespaces AKS always excludes. */
    systemExcludedNamespaces: string[];
    /** Observed Pod Security Standards level. */
    podSecurityStandardsLevel: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Deployment safeguards of an AKS cluster: Azure Policy best-practice
 * checks (resource limits, probes, image tags, ...) applied to every
 * deployment, in `Warn` or `Enforce` mode. Deleting the resource turns the
 * safeguards off.
 *
 * Safeguards are an extension resource without tags; ownership follows the
 * cluster's Alchemy tags. Enabling them installs the Azure Policy add-on and
 * can take 10-20 minutes to propagate.
 *
 * @see https://learn.microsoft.com/azure/aks/deployment-safeguards
 *
 * ### Enforcing Best Practices
 * **Example:** Warn on non-compliant deployments
 * ```typescript
 * yield* Azure.ContainerService.DeploymentSafeguard("safeguards", {
 *   clusterId: cluster.clusterId,
 *   level: "Warn",
 *   excludedNamespaces: ["legacy"],
 * });
 * ```
 *
 * @resource
 */
export const DeploymentSafeguard = Resource<DeploymentSafeguard>(
  "Azure.ContainerService.DeploymentSafeguard",
);

type ObservedSafeguard = cs.GetDeploymentSafeguardResponse;

const getSafeguard = (resourceUri: string) =>
  orUndefinedIfNotFound(cs.GetDeploymentSafeguard({ resourceUri }));

const toAttrs = (
  clusterId: string,
  safeguard: ObservedSafeguard,
): DeploymentSafeguard["Attributes"] => ({
  safeguardId: safeguard.id ?? "",
  clusterId,
  level: safeguard.properties?.level ?? "",
  excludedNamespaces: [...(safeguard.properties?.excludedNamespaces ?? [])],
  systemExcludedNamespaces: [
    ...(safeguard.properties?.systemExcludedNamespaces ?? []),
  ],
  podSecurityStandardsLevel: safeguard.properties?.podSecurityStandardsLevel,
});

const stateOf = (safeguard: ObservedSafeguard) =>
  safeguard.properties?.provisioningState;

const clusterNameOf = (clusterId: string) =>
  clusterId.match(/\/managedClusters\/([^/]+)/i)?.[1];

const sameList = (a: readonly string[], b: readonly string[]) =>
  [...a].sort().join("\n") === [...b].sort().join("\n");

const matches = (
  news: DeploymentSafeguardProps,
  observed: ObservedSafeguard["properties"],
) =>
  observed !== undefined &&
  observed.level === news.level &&
  sameList(observed.excludedNamespaces ?? [], news.excludedNamespaces ?? []) &&
  (news.podSecurityStandardsLevel === undefined ||
    observed.podSecurityStandardsLevel === news.podSecurityStandardsLevel);

export const DeploymentSafeguardProvider = () =>
  Provider.succeed(DeploymentSafeguard, {
    stables: ["safeguardId", "clusterId"],

    // A singleton extension of its cluster; nuke removes it with the cluster.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (!sameName(news.clusterId, output.clusterId)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const clusterId = output?.clusterId ?? olds?.clusterId;
      if (clusterId === undefined) return undefined;
      const observed = yield* getSafeguard(clusterId);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(clusterId, observed);
      const group = resourceGroupOf(clusterId);
      const cluster = clusterNameOf(clusterId);
      return group !== undefined &&
        cluster !== undefined &&
        (yield* isClusterOwned(subscriptionId, group, cluster))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerService");
      const get = getSafeguard(news.clusterId);
      // Enabling installs the Azure Policy add-on (several minutes).
      const waitReady = waitForProvisioned(
        `deployment safeguards of ${news.clusterId}`,
        get,
        stateOf,
        { interval: "15 seconds", times: 60 },
      );

      // Observe, then PUT the singleton only on drift.
      const observed = yield* get;
      if (observed === undefined || !matches(news, observed.properties)) {
        yield* cs
          .CreateDeploymentSafeguard({
            resourceUri: news.clusterId,
            properties: {
              level: news.level,
              excludedNamespaces: news.excludedNamespaces ?? [],
              podSecurityStandardsLevel: news.podSecurityStandardsLevel,
            },
          })
          .pipe(Effect.retry(whileClusterBusy));
      }

      const fresh = yield* waitReady;
      return toAttrs(news.clusterId, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        cs
          .DeleteDeploymentSafeguard({ resourceUri: output.clusterId })
          .pipe(Effect.retry(whileClusterBusy)),
      );
      yield* waitUntilGone(
        `deployment safeguards of ${output.clusterId}`,
        getSafeguard(output.clusterId),
        { interval: "15 seconds", times: 60 },
      );
    }),
  });
