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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createChildName,
  isClusterOwned,
  sameName,
  whileClusterBusy,
} from "./Common.ts";

export interface TrustedAccessRoleBindingProps {
  /** Resource group of the cluster. Changing it replaces the binding. */
  resourceGroup: string;
  /** Name of the managed cluster. Changing it replaces the binding. */
  cluster: string;
  /**
   * Binding name: 1-24 letters, digits, `-`, `_`, and `.`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the binding.
   */
  name?: string;
  /**
   * ARM resource ID of the Azure resource granted access (e.g. a Backup
   * vault or Machine Learning workspace). Changing it replaces the binding.
   */
  sourceResourceId: string;
  /**
   * Trusted access roles granted, as `{resourceType}/{role}`, e.g.
   * `Microsoft.DataProtection/backupVaults/backup-operator`.
   */
  roles: string[];
}

export interface TrustedAccessRoleBinding extends Resource<
  "Azure.ContainerService.TrustedAccessRoleBinding",
  TrustedAccessRoleBindingProps,
  {
    /** Name of the binding. */
    bindingName: string;
    /** ARM resource ID of the binding. */
    bindingId: string;
    /** Name of the managed cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** ARM resource ID of the resource granted access. */
    sourceResourceId: string;
    /** Observed roles. */
    roles: string[];
  },
  never,
  Providers
> {}

/**
 * Grants an Azure service resource (Backup vault, Machine Learning
 * workspace, ...) a Kubernetes role inside an AKS cluster through trusted
 * access, without opening the API server.
 *
 * Bindings cannot be tagged; ownership follows the cluster's Alchemy tags.
 *
 * @see https://learn.microsoft.com/azure/aks/trusted-access-feature
 *
 * ### Granting Trusted Access
 * **Example:** Let a Backup vault back up the cluster
 * ```typescript
 * yield* Azure.ContainerService.TrustedAccessRoleBinding("backup", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   sourceResourceId: vaultId,
 *   roles: ["Microsoft.DataProtection/backupVaults/backup-operator"],
 * });
 * ```
 *
 * @resource
 */
export const TrustedAccessRoleBinding = Resource<TrustedAccessRoleBinding>(
  "Azure.ContainerService.TrustedAccessRoleBinding",
);

type ObservedBinding = cs.GetTrustedAccessRoleBindingResponse;

const createBindingName = (id: string) => createChildName(id, 24);

const getBinding = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  trustedAccessRoleBindingName: string,
) =>
  orUndefinedIfNotFound(
    cs.GetTrustedAccessRoleBinding({
      subscriptionId,
      resourceGroupName,
      resourceName,
      trustedAccessRoleBindingName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  binding: ObservedBinding,
): TrustedAccessRoleBinding["Attributes"] => ({
  bindingName: name,
  bindingId: binding.id ?? "",
  cluster,
  resourceGroup,
  sourceResourceId: binding.properties.sourceResourceId,
  roles: [...binding.properties.roles],
});

const stateOf = (binding: ObservedBinding) =>
  binding.properties.provisioningState;

const normalizeRoles = (roles: readonly string[]) =>
  roles
    .map((role) => role.toLowerCase())
    .sort()
    .join("\n");

const sameRoles = (a: readonly string[], b: readonly string[]) =>
  normalizeRoles(a) === normalizeRoles(b);

export const TrustedAccessRoleBindingProvider = () =>
  Provider.succeed(TrustedAccessRoleBinding, {
    stables: ["bindingName", "bindingId", "cluster", "resourceGroup"],

    // Bindings live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.cluster, output.cluster) ||
        (news.name !== undefined && news.name !== output.bindingName) ||
        !sameName(news.sourceResourceId, output.sourceResourceId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      if (resourceGroup === undefined || cluster === undefined)
        return undefined;
      const name =
        output?.bindingName ?? olds?.name ?? (yield* createBindingName(id));
      const observed = yield* getBinding(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      return (yield* isClusterOwned(subscriptionId, resourceGroup, cluster))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerService");
      const { resourceGroup, cluster } = news;
      const name =
        news.name ?? output?.bindingName ?? (yield* createBindingName(id));
      const get = getBinding(subscriptionId, resourceGroup, cluster, name);
      const waitReady = waitForProvisioned(
        `trusted access role binding ${cluster}/${name}`,
        get,
        stateOf,
        { interval: "5 seconds", times: 60 },
      );

      // Observe, then PUT the binding only when missing or roles drift.
      const observed = yield* get;
      if (
        observed === undefined ||
        !sameRoles(observed.properties.roles, news.roles)
      ) {
        yield* cs
          .TrustedAccessRoleBindingsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            resourceName: cluster,
            trustedAccessRoleBindingName: name,
            properties: {
              sourceResourceId: news.sourceResourceId,
              roles: news.roles,
            },
          })
          .pipe(Effect.retry(whileClusterBusy));
      }

      const fresh = yield* waitReady;
      return toAttrs(resourceGroup, cluster, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cs
          .DeleteTrustedAccessRoleBinding({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.cluster,
            trustedAccessRoleBindingName: output.bindingName,
          })
          .pipe(Effect.retry(whileClusterBusy)),
      );
      yield* waitUntilGone(
        `trusted access role binding ${output.cluster}/${output.bindingName}`,
        getBinding(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.bindingName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
