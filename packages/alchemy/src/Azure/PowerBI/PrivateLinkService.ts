import * as powerbi from "@distilled.cloud/azure/powerbiprivatelinks";
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
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface PrivateLinkServiceProps {
  /**
   * Resource group the private link service is created in. Changing it
   * replaces the service.
   */
  resourceGroup: string;
  /**
   * Name of the private link service. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * service.
   */
  name?: string;
  /**
   * Azure location of the service. Power BI private link services are
   * global resources. Changing it replaces the service.
   * @default "global"
   */
  location?: string;
  /**
   * Microsoft Entra tenant whose Power BI / Fabric tenant is exposed over
   * Private Link. Changing it replaces the service.
   * @default the tenant of the current Azure credentials
   */
  tenantId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface PrivateLinkService extends Resource<
  "Azure.PowerBI.PrivateLinkService",
  PrivateLinkServiceProps,
  {
    /** Name of the private link service. */
    privateLinkServiceName: string;
    /**
     * ARM resource ID of the private link service. Use it as the
     * `privateLinkServiceId` of a `Network.PrivateEndpoint` (group `tenant`).
     */
    privateLinkServiceId: string;
    /** Resource group that holds the service. */
    resourceGroup: string;
    /** Location of the service. */
    location: string;
    /** Entra tenant the service exposes. */
    tenantId: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Power BI private link service (`privateLinkServicesForPowerBI`) — the
 * tenant-bound endpoint a private endpoint attaches to so a virtual network
 * reaches the Power BI / Fabric tenant privately.
 *
 * A Power BI / Fabric administrator must first enable *Azure Private Link*
 * in the Fabric admin portal; until then the Power BI resource provider
 * rejects every request.
 *
 * @see https://learn.microsoft.com/fabric/security/security-private-links-use
 *
 * ### Creating a Private Link Service
 * **Example:** Private link service for the current tenant
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("powerbi");
 * const service = yield* Azure.PowerBI.PrivateLinkService("tenant", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * ### Connecting a Virtual Network
 * **Example:** Private endpoint into the Power BI tenant
 * ```typescript
 * const endpoint = yield* Azure.Network.PrivateEndpoint("powerbi", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   privateLinkServiceConnections: [
 *     { privateLinkServiceId: service.privateLinkServiceId, groupIds: ["tenant"] },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const PrivateLinkService = Resource<PrivateLinkService>(
  "Azure.PowerBI.PrivateLinkService",
);

type Observed = powerbi.TenantResource;

const sameName = (a: string | undefined, b: string) =>
  (a ?? "").toLowerCase() === b.toLowerCase();

/** The service by name; the GET returns a (single-element) array. */
export const getPowerBIPrivateLinkService = (
  subscriptionId: string,
  resourceGroupName: string,
  azureResourceName: string,
) =>
  orUndefinedIfNotFound(
    powerbi.ListPowerBIResourceByResourceName({
      subscriptionId,
      resourceGroupName,
      azureResourceName,
    }),
  ).pipe(
    Effect.map((found) =>
      found?.find((service) => sameName(service.name, azureResourceName)),
    ),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  service: Observed,
  fallback: { location: string; tenantId: string },
): PrivateLinkService["Attributes"] => ({
  privateLinkServiceName: name,
  privateLinkServiceId: service.id ?? "",
  resourceGroup,
  location: service.location ?? fallback.location,
  tenantId: service.properties?.tenantId ?? fallback.tenantId,
  tags: userTags(service.tags),
});

const createName = (id: string) =>
  createPhysicalName({ id, maxLength: 64, lowercase: true });

export const PrivateLinkServiceProvider = () =>
  Provider.succeed(PrivateLinkService, {
    stables: [
      "privateLinkServiceName",
      "privateLinkServiceId",
      "resourceGroup",
      "location",
      "tenantId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const services =
        (yield* orUndefinedIfNotFound(
          powerbi.ListPrivateLinkServicesForPowerBIBySubscriptionId({
            subscriptionId,
          }),
        )) ?? [];
      return services.flatMap((service) => {
        const group = resourceGroupOf(service.id);
        return hasAnyAlchemyTag(service.tags) &&
          group !== undefined &&
          service.name !== undefined
          ? [
              toAttrs(group, service.name, service, {
                location: "global",
                tenantId: "",
              }),
            ]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          !sameName(news.name, output.privateLinkServiceName)) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location)) ||
        (news.tenantId !== undefined &&
          !sameName(news.tenantId, output.tenantId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.privateLinkServiceName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getPowerBIPrivateLinkService(
        env.subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed, {
        location: olds?.location ?? "global",
        tenantId: olds?.tenantId ?? env.tenantId,
      });
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.PowerBI");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.privateLinkServiceName ?? (yield* createName(id));
      const location = news.location ?? output?.location ?? "global";
      const tenantId = news.tenantId ?? output?.tenantId ?? env.tenantId;
      const tags = yield* desiredTags(id, news.tags);
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        azureResourceName: name,
      };

      // Observe.
      let observed = yield* getPowerBIPrivateLinkService(
        subscriptionId,
        resourceGroup,
        name,
      );

      // Ensure: the PUT is a synchronous upsert.
      if (observed === undefined) {
        observed = yield* powerbi.CreatePowerBIResource({
          ...request,
          location,
          properties: { tenantId },
          tags,
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        // Sync tags, the only mutable aspect.
        observed = yield* powerbi.UpdatePowerBIResource({ ...request, tags });
      }

      return toAttrs(resourceGroup, name, observed, { location, tenantId });
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        powerbi.DeletePowerBIResource({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          azureResourceName: output.privateLinkServiceName,
        }),
      );
      yield* waitUntilGone(
        `Power BI private link service ${output.privateLinkServiceName}`,
        getPowerBIPrivateLinkService(
          subscriptionId,
          output.resourceGroup,
          output.privateLinkServiceName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
