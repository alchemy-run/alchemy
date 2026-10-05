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

export interface IdentityBindingProps {
  /** Resource group of the cluster. Changing it replaces the binding. */
  resourceGroup: string;
  /** Name of the managed cluster. Changing it replaces the binding. */
  cluster: string;
  /**
   * Binding name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the binding.
   */
  name?: string;
  /**
   * ARM resource ID of the user-assigned managed identity to bind.
   * Changing it replaces the binding.
   */
  managedIdentityId: string;
}

export interface IdentityBinding extends Resource<
  "Azure.ContainerService.IdentityBinding",
  IdentityBindingProps,
  {
    /** Name of the binding. */
    bindingName: string;
    /** ARM resource ID of the binding. */
    bindingId: string;
    /** Name of the managed cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** ARM resource ID of the bound identity. */
    managedIdentityId: string;
    /** Client ID of the bound identity. */
    clientId: string | undefined;
    /** Object (principal) ID of the bound identity. */
    objectId: string | undefined;
    /** OIDC issuer URL workloads use to federate with the identity. */
    oidcIssuerUrl: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Binds a user-assigned managed identity to an AKS cluster so workloads can
 * use it through workload identity without one federated credential per
 * service account (identity bindings).
 *
 * Bindings cannot be tagged; ownership follows the cluster's Alchemy tags.
 *
 * @see https://learn.microsoft.com/azure/aks/identity-bindings-concepts
 *
 * ### Binding an Identity
 * **Example:** Bind a user-assigned identity to a cluster
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("app", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const binding = yield* Azure.ContainerService.IdentityBinding("app", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   managedIdentityId: identity.identityId,
 * });
 * ```
 *
 * @resource
 */
export const IdentityBinding = Resource<IdentityBinding>(
  "Azure.ContainerService.IdentityBinding",
);

type ObservedBinding = cs.GetIdentityBindingResponse;

const createBindingName = (id: string) => createChildName(id, 63);

const getBinding = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  identityBindingName: string,
) =>
  orUndefinedIfNotFound(
    cs.GetIdentityBinding({
      subscriptionId,
      resourceGroupName,
      resourceName,
      identityBindingName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  binding: ObservedBinding,
): IdentityBinding["Attributes"] => ({
  bindingName: name,
  bindingId: binding.id ?? "",
  cluster,
  resourceGroup,
  managedIdentityId: binding.properties?.managedIdentity.resourceId ?? "",
  clientId: binding.properties?.managedIdentity.clientId,
  objectId: binding.properties?.managedIdentity.objectId,
  oidcIssuerUrl: binding.properties?.oidcIssuer?.oidcIssuerUrl,
});

const stateOf = (binding: ObservedBinding) =>
  binding.properties?.provisioningState;

export const IdentityBindingProvider = () =>
  Provider.succeed(IdentityBinding, {
    stables: [
      "bindingName",
      "bindingId",
      "cluster",
      "resourceGroup",
      "managedIdentityId",
    ],

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
        !sameName(news.managedIdentityId, output.managedIdentityId)
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

      // Observe, then PUT when missing (the identity is the only property).
      const observed = yield* get;
      if (observed === undefined) {
        yield* cs
          .IdentityBindingsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            resourceName: cluster,
            identityBindingName: name,
            properties: {
              managedIdentity: { resourceId: news.managedIdentityId },
            },
          })
          .pipe(Effect.retry(whileClusterBusy));
      }

      const fresh = yield* waitForProvisioned(
        `identity binding ${cluster}/${name}`,
        get,
        stateOf,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, cluster, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cs
          .DeleteIdentityBinding({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.cluster,
            identityBindingName: output.bindingName,
          })
          .pipe(Effect.retry(whileClusterBusy)),
      );
      yield* waitUntilGone(
        `identity binding ${output.cluster}/${output.bindingName}`,
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
