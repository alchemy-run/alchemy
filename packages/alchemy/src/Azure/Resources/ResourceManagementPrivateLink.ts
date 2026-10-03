import * as resources from "@distilled.cloud/azure/resources";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface ResourceManagementPrivateLinkProps {
  /** Resource group of the private link. Changing it replaces it. */
  resourceGroup: string;
  /**
   * Name of the resource management private link. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the private link.
   */
  name?: string;
  /**
   * Azure region of the private link. Changing it replaces the private link.
   * @default the provider's configured location
   */
  location?: string;
}

export interface ResourceManagementPrivateLink extends Resource<
  "Azure.Resources.ResourceManagementPrivateLink",
  ResourceManagementPrivateLinkProps,
  {
    /** Name of the private link. */
    resourceManagementPrivateLinkName: string;
    /**
     * ARM ID of the private link — the target of a private endpoint
     * (group `ResourceManagement`) and of an
     * `Azure.Authorization.PrivateLinkAssociation`.
     */
    resourceManagementPrivateLinkId: string;
    /** Resource group of the private link. */
    resourceGroup: string;
    /** Azure region of the private link. */
    location: string;
    /** ARM IDs of the private endpoint connections to this private link. */
    privateEndpointConnections: string[];
  },
  never,
  Providers
> {}

/**
 * A resource management private link — the endpoint that lets a private
 * endpoint reach Azure Resource Manager (management.azure.com) over a
 * private network. Associate it with a management group through
 * `Azure.Authorization.PrivateLinkAssociation` to restrict management
 * traffic for that group to private links.
 *
 * The resource has no tags and no mutable settings: it only exists.
 *
 * @see https://learn.microsoft.com/azure/azure-resource-manager/management/create-private-link-access-portal
 *
 * ### Creating a Private Link
 * **Example:** Private link for Azure Resource Manager
 * ```typescript
 * const rmpl = yield* Azure.Resources.ResourceManagementPrivateLink("arm", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // point a private endpoint (group "ResourceManagement") at
 * // rmpl.resourceManagementPrivateLinkId
 * ```
 *
 * @resource
 */
export const ResourceManagementPrivateLink =
  Resource<ResourceManagementPrivateLink>(
    "Azure.Resources.ResourceManagementPrivateLink",
  );

const linkNameOf = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, maxLength: 64 });

const getLink = (
  subscriptionId: string,
  resourceGroupName: string,
  rmplName: string,
) =>
  orUndefinedIfNotFound(
    resources.GetResourceManagementPrivateLink({
      subscriptionId,
      resourceGroupName,
      rmplName,
    }),
  );

const region = (value: string) => value.toLowerCase().replace(/\s/g, "");

const toAttrs = (
  subscriptionId: string,
  resourceGroup: string,
  name: string,
  location: string,
  observed: resources.ResourceManagementPrivateLink,
): ResourceManagementPrivateLink["Attributes"] => ({
  resourceManagementPrivateLinkName: name,
  resourceManagementPrivateLinkId:
    observed.id ??
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Authorization/resourceManagementPrivateLinks/${name}`,
  resourceGroup,
  location: observed.location ?? location,
  privateEndpointConnections:
    observed.properties?.privateEndpointConnections ?? [],
});

export const ResourceManagementPrivateLinkProvider = () =>
  Provider.succeed(ResourceManagementPrivateLink, {
    stables: [
      "resourceManagementPrivateLinkName",
      "resourceManagementPrivateLinkId",
      "resourceGroup",
      "location",
    ],

    // No tags or markers: report links in Alchemy-owned resource groups.
    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const groups = yield* resources
        .ListResourceGroups({
          subscriptionId,
          _filter: "tagName eq 'alchemy::stack'",
        })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListResourceGroups", page),
          ),
        );
      const perGroup = yield* Effect.forEach(
        (groups.value ?? []).flatMap((group) =>
          group.name === undefined ? [] : [group.name],
        ),
        (resourceGroupName) =>
          orUndefinedIfNotFound(
            resources.ListResourceManagementPrivateLinkByResourceGroup({
              subscriptionId,
              resourceGroupName,
            }),
          ).pipe(
            Effect.map((page) =>
              (page?.value ?? []).flatMap((link) =>
                link.name === undefined
                  ? []
                  : [
                      toAttrs(
                        subscriptionId,
                        resourceGroupName,
                        link.name,
                        link.location ?? "",
                        link,
                      ),
                    ],
              ),
            ),
          ),
        { concurrency: 4 },
      );
      return perGroup.flat();
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (!isResolved(news)) {
        return !("resourceGroup" in news) || !isResolved(news.resourceGroup)
          ? ({ action: "replace" } as const)
          : undefined;
      }
      const { location } = yield* AzureEnvironment.current;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.resourceManagementPrivateLinkName.toLowerCase()) ||
        region(news.location ?? location) !== region(output.location)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId, location } = yield* AzureEnvironment.current;
      const group = output?.resourceGroup ?? olds?.resourceGroup;
      if (group === undefined) return undefined;
      const name =
        output?.resourceManagementPrivateLinkName ??
        (yield* linkNameOf(id, olds?.name));
      const observed = yield* getLink(subscriptionId, group, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        subscriptionId,
        group,
        name,
        olds?.location ?? location,
        observed,
      );
      // No tags or markers to prove ownership: only a link we have state
      // for is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Authorization");
      const group = news.resourceGroup;
      const name =
        output?.resourceManagementPrivateLinkName ??
        (yield* linkNameOf(id, news.name));
      const location = news.location ?? env.location;

      // Observe → ensure. Existence-only: nothing to sync.
      let observed = yield* getLink(subscriptionId, group, name);
      if (observed === undefined) {
        observed = yield* resources.PutResourceManagementPrivateLink({
          subscriptionId,
          resourceGroupName: group,
          rmplName: name,
          location,
        });
      }
      return toAttrs(subscriptionId, group, name, location, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        resources.DeleteResourceManagementPrivateLink({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          rmplName: output.resourceManagementPrivateLinkName,
        }),
      );
      yield* waitUntilGone(
        `resource management private link ${output.resourceManagementPrivateLinkName}`,
        getLink(
          subscriptionId,
          output.resourceGroup,
          output.resourceManagementPrivateLinkName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
