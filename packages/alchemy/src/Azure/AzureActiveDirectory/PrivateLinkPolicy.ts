import * as aad from "@distilled.cloud/azure/azureactivedirectory";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface PrivateLinkPolicyProps {
  /**
   * Resource group the policy is created in. Changing it replaces the
   * policy.
   */
  resourceGroup: string;
  /**
   * Name of the policy. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the policy.
   */
  name?: string;
  /**
   * Microsoft Entra tenant that owns the policy. Changing it replaces the
   * policy.
   * @default the tenant of the current Azure credentials
   */
  ownerTenantId?: string;
  /**
   * Whether every Microsoft Entra tenant may be reached through the private
   * link. When `false`, only the tenants in `tenants` are reachable.
   * @default false
   */
  allTenants?: boolean;
  /**
   * Tenant IDs reachable through the private link when `allTenants` is
   * `false`.
   * @default [ownerTenantId]
   */
  tenants?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface PrivateLinkPolicy extends Resource<
  "Azure.AzureActiveDirectory.PrivateLinkPolicy",
  PrivateLinkPolicyProps,
  {
    /** Name of the policy. */
    policyName: string;
    /**
     * ARM resource ID of the policy. Use it as the `privateLinkServiceId`
     * of a `Network.PrivateEndpoint` (group `azuread`).
     */
    policyId: string;
    /** Resource group that holds the policy. */
    resourceGroup: string;
    /** Microsoft Entra tenant that owns the policy. */
    ownerTenantId: string;
    /** Whether every tenant is reachable through the private link. */
    allTenants: boolean;
    /** Tenant IDs reachable through the private link. */
    tenants: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Private Link for Microsoft Entra ID policy
 * (`microsoft.aadiam/privateLinkForAzureAd`) — the endpoint a private
 * endpoint attaches to so sign-ins from a virtual network reach Microsoft
 * Entra ID privately, restricted to an allow-list of tenants.
 *
 * Creating the policy requires the caller to be a Global Administrator of
 * the tenant, and the resource type must be available on the subscription
 * (it is a preview feature; subscriptions without it get
 * `InvalidResourceType`).
 *
 * @see https://learn.microsoft.com/entra/identity/devices/howto-manage-private-link
 *
 * ### Creating a Policy
 * **Example:** Allow only the current tenant
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("identity");
 * const policy = yield* Azure.AzureActiveDirectory.PrivateLinkPolicy("entra", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Allow a list of partner tenants
 * ```typescript
 * const policy = yield* Azure.AzureActiveDirectory.PrivateLinkPolicy("entra", {
 *   resourceGroup: group.resourceGroupName,
 *   tenants: [homeTenantId, partnerTenantId],
 *   tags: { team: "identity" },
 * });
 * ```
 *
 * ### Connecting a Virtual Network
 * **Example:** Private endpoint into Microsoft Entra ID
 * ```typescript
 * const endpoint = yield* Azure.Network.PrivateEndpoint("entra", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   privateLinkServiceConnections: [
 *     { privateLinkServiceId: policy.policyId, groupIds: ["azuread"] },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const PrivateLinkPolicy = Resource<PrivateLinkPolicy>(
  "Azure.AzureActiveDirectory.PrivateLinkPolicy",
);

type Observed = aad.PrivateLinkPolicy;

const sameName = (a: string | undefined, b: string) =>
  (a ?? "").toLowerCase() === b.toLowerCase();

const sameTenants = (a: string[] | undefined, b: string[]) => {
  const left = [...(a ?? [])].map((t) => t.toLowerCase()).sort();
  const right = [...b].map((t) => t.toLowerCase()).sort();
  return left.length === right.length && left.every((t, i) => t === right[i]);
};

/**
 * The policy by name, or `undefined` when it does not exist. Where the
 * subscription does not expose `privateLinkForAzureAd`, every call fails with
 * `InvalidResourceType`: no policy can exist there, so reads and deletes treat
 * it as absent; creates surface it.
 */
export const getAadPrivateLinkPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  policyName: string,
) =>
  orUndefinedIfNotFound(
    aad.GetPrivateLinkForAzureAd({
      subscriptionId,
      resourceGroupName,
      policyName,
    }),
  ).pipe(
    Effect.catchTag("InvalidResourceType", () => Effect.succeed(undefined)),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  policy: Observed,
  fallback: { ownerTenantId: string },
): PrivateLinkPolicy["Attributes"] => ({
  policyName: name,
  policyId: policy.id ?? "",
  resourceGroup,
  ownerTenantId: policy.ownerTenantId ?? fallback.ownerTenantId,
  allTenants: policy.allTenants ?? false,
  tenants: policy.tenants ?? [],
  tags: userTags(policy.tags),
});

const createName = (id: string) => createPhysicalName({ id, maxLength: 64 });

export const PrivateLinkPolicyProvider = () =>
  Provider.succeed(PrivateLinkPolicy, {
    stables: ["policyName", "policyId", "resourceGroup", "ownerTenantId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        aad
          .ListPrivateLinkForAzureAdBySubscription({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage(
                "ListPrivateLinkForAzureAdBySubscription",
                page,
              ),
            ),
          ),
      ).pipe(
        Effect.catchTag("InvalidResourceType", () => Effect.succeed(undefined)),
      );
      return (page?.value ?? []).flatMap((policy) => {
        const group = resourceGroupOf(policy.id) ?? policy.resourceGroup;
        return hasAnyAlchemyTag(policy.tags) &&
          group !== undefined &&
          policy.name !== undefined
          ? [toAttrs(group, policy.name, policy, { ownerTenantId: "" })]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameName(news.name, output.policyName)) ||
        (news.ownerTenantId !== undefined &&
          !sameName(news.ownerTenantId, output.ownerTenantId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.policyName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getAadPrivateLinkPolicy(
        env.subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed, {
        ownerTenantId: olds?.ownerTenantId ?? env.tenantId,
      });
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "microsoft.aadiam");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.policyName ?? (yield* createName(id));
      const ownerTenantId =
        news.ownerTenantId ?? output?.ownerTenantId ?? env.tenantId;
      const allTenants = news.allTenants ?? false;
      const tenants = news.tenants ?? [ownerTenantId];
      const tags = yield* desiredTags(id, news.tags);
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        policyName: name,
      };
      const get = getAadPrivateLinkPolicy(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure + sync the policy body: the PUT is an idempotent upsert of
      // the whole body (tags included), sent only when missing or drifted.
      if (
        observed === undefined ||
        (observed.allTenants ?? false) !== allTenants ||
        !sameTenants(observed.tenants, tenants)
      ) {
        yield* aad.CreatePrivateLinkForAzureAd({
          ...request,
          name,
          ownerTenantId: observed?.ownerTenantId ?? ownerTenantId,
          allTenants,
          tenants,
          resourceName: name,
          resourceGroup,
          tags,
        });
        observed = yield* waitForProvisioned(
          `Entra private link policy ${name}`,
          get,
          () => undefined,
        );
      }

      // Sync tags, the only PATCH-able aspect.
      if (tagsDiffer(observed.tags, tags)) {
        observed = yield* aad.UpdatePrivateLinkForAzureAd({ ...request, tags });
      }

      return toAttrs(resourceGroup, name, observed, { ownerTenantId });
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        aad.DeletePrivateLinkForAzureAd({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          policyName: output.policyName,
        }),
      ).pipe(Effect.catchTag("InvalidResourceType", () => Effect.void));
      yield* waitUntilGone(
        `Entra private link policy ${output.policyName}`,
        getAadPrivateLinkPolicy(
          subscriptionId,
          output.resourceGroup,
          output.policyName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
