import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
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

export interface PrivateLinkScopeProps {
  /**
   * Resource group the private link scope is created in. Changing it
   * replaces the scope.
   */
  resourceGroup: string;
  /**
   * Name of the private link scope, at most 54 characters. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the scope.
   */
  name?: string;
  /**
   * Azure location of the scope. Changing it replaces the scope.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Whether machines associated with the scope may also reach the public
   * Azure Arc endpoints.
   * @default "Disabled"
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Azure Arc extensions whose traffic is validated over the private
   * link.
   */
  serviceExtensions?: PrivateLinkScopeServiceExtension[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

/**
 * An Azure Arc extension whose traffic is validated over the private link.
 */
export interface PrivateLinkScopeServiceExtension {
  /** Name of the Azure Arc extension. */
  serviceExtensionType?: string;
  /**
   * Whether the extension may use public Azure Arc extension endpoints.
   */
  serviceExtensionPublicNetworkAccess?: "Enabled" | "Disabled";
}

export interface PrivateLinkScope extends Resource<
  "Azure.HybridCompute.PrivateLinkScope",
  PrivateLinkScopeProps,
  {
    /** Name of the private link scope. */
    privateLinkScopeName: string;
    /** Resource group that holds the scope. */
    resourceGroup: string;
    /** ARM resource ID of the scope. */
    privateLinkScopeResourceId: string;
    /**
     * GUID of the scope, passed to `azcmagent connect --private-link-scope`.
     */
    privateLinkScopeId: string;
    /** Location of the scope. */
    location: string;
    /** Whether public Azure Arc endpoints are reachable. */
    publicNetworkAccess: string;
    /** Extensions validated over the private link. */
    serviceExtensions: PrivateLinkScopeServiceExtension[];
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc private link scope — the target of a private endpoint
 * (`groupId: "hybridcompute"`) that lets Arc-enabled servers reach Azure
 * Arc over a private network instead of the public internet.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/servers/private-link-security
 *
 * ### Creating a Private Link Scope
 * **Example:** Scope with public access disabled
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("arc");
 * const scope = yield* Azure.HybridCompute.PrivateLinkScope("arc-scope", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Scope that also allows the public endpoints
 * ```typescript
 * const scope = yield* Azure.HybridCompute.PrivateLinkScope("arc-scope", {
 *   resourceGroup: group.resourceGroupName,
 *   publicNetworkAccess: "Enabled",
 * });
 * ```
 *
 * ### Onboarding Machines
 * **Example:** Pass the scope to the Connected Machine agent
 * ```typescript
 * // azcmagent connect --private-link-scope <privateLinkScopeResourceId> ...
 * const scopeId = scope.privateLinkScopeResourceId;
 * ```
 *
 * @resource
 */
export const PrivateLinkScope = Resource<PrivateLinkScope>(
  "Azure.HybridCompute.PrivateLinkScope",
);

type ObservedScope = hybridcompute.GetPrivateLinkScopeResponse;

const getScope = (
  subscriptionId: string,
  resourceGroupName: string,
  scopeName: string,
) =>
  orUndefinedIfNotFound(
    hybridcompute.GetPrivateLinkScope({
      subscriptionId,
      resourceGroupName,
      scopeName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  scope: ObservedScope,
): PrivateLinkScope["Attributes"] => ({
  privateLinkScopeName: name,
  resourceGroup,
  privateLinkScopeResourceId: scope.id ?? "",
  privateLinkScopeId: scope.properties?.privateLinkScopeId ?? "",
  location: scope.location,
  publicNetworkAccess: scope.properties?.publicNetworkAccess ?? "Disabled",
  serviceExtensions: (scope.properties?.serviceExtensions ?? []).map((ext) => ({
    serviceExtensionType: ext.serviceExtensionType,
    serviceExtensionPublicNetworkAccess:
      ext.serviceExtensionPublicNetworkAccess === "Enabled"
        ? ("Enabled" as const)
        : ext.serviceExtensionPublicNetworkAccess === "Disabled"
          ? ("Disabled" as const)
          : undefined,
  })),
  provisioningState: scope.properties?.provisioningState,
  tags: userTags(scope.tags),
});

const extensionKey = (ext: hybridcompute.ServiceExtension) =>
  `${ext.serviceExtensionType ?? ""}|${ext.serviceExtensionPublicNetworkAccess ?? ""}`.toLowerCase();

const sameSet = (
  a: readonly hybridcompute.ServiceExtension[],
  b: readonly hybridcompute.ServiceExtension[],
) => {
  const left = a.map(extensionKey).sort();
  const right = b.map(extensionKey).sort();
  return left.length === right.length && left.every((x, i) => x === right[i]);
};

const nameOf = (id: string) => createPhysicalName({ id, maxLength: 54 });

export const PrivateLinkScopeProvider = () =>
  Provider.succeed(PrivateLinkScope, {
    stables: [
      "privateLinkScopeName",
      "resourceGroup",
      "privateLinkScopeResourceId",
      "privateLinkScopeId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* hybridcompute
        .ListPrivateLinkScopes({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPrivateLinkScopes", page),
          ),
        );
      return (page.value ?? []).flatMap((scope) => {
        const group = resourceGroupOf(scope.id);
        return hasAnyAlchemyTag(scope.tags) &&
          group !== undefined &&
          scope.name !== undefined
          ? [toAttrs(group, scope.name, scope)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.privateLinkScopeName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.privateLinkScopeName ?? olds?.name ?? (yield* nameOf(id));
      const observed = yield* getScope(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.HybridCompute");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.privateLinkScopeName ?? (yield* nameOf(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const publicNetworkAccess = news.publicNetworkAccess ?? "Disabled";
      const serviceExtensions = news.serviceExtensions ?? [];
      const label = `private link scope ${name}`;
      const get = getScope(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure + sync properties: the PUT is a synchronous upsert.
      if (
        observed === undefined ||
        (observed.properties?.publicNetworkAccess ?? "Disabled") !==
          publicNetworkAccess ||
        !sameSet(
          observed.properties?.serviceExtensions ?? [],
          serviceExtensions,
        )
      ) {
        yield* hybridcompute.PrivateLinkScopesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          scopeName: name,
          location: observed?.location ?? location,
          tags,
          properties: { publicNetworkAccess, serviceExtensions },
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (scope) => scope.properties?.provisioningState,
        );
      }

      // Sync tags against observed cloud tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* hybridcompute.UpdatePrivateLinkScopeTags({
          subscriptionId,
          resourceGroupName: resourceGroup,
          scopeName: name,
          tags,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (scope) => scope.properties?.provisioningState,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridcompute.DeletePrivateLinkScope({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          scopeName: output.privateLinkScopeName,
        }),
      );
      yield* waitUntilGone(
        `private link scope ${output.privateLinkScopeName}`,
        getScope(
          subscriptionId,
          output.resourceGroup,
          output.privateLinkScopeName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
