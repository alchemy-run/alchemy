import * as peering from "@distilled.cloud/azure/peering";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createPeeringName, getPeeringService } from "./Common.ts";

export interface PeeringServiceProps {
  /** Resource group the peering service is created in. Changing it replaces the peering service. */
  resourceGroup: string;
  /**
   * Name of the peering service. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the peering
   * service.
   */
  name?: string;
  /**
   * Azure location of the ARM resource. Changing it replaces the peering
   * service.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Customer location served by the peering service, e.g. a US state
   * (`Washington`) or a country. Changing it replaces the peering service.
   */
  peeringServiceLocation: string;
  /**
   * Name of the Peering Service partner provider, as returned by
   * `ListPeeringServiceProviders` (e.g. `T-Mobile USA`). Changing it
   * replaces the peering service.
   */
  peeringServiceProvider: string;
  /**
   * The provider's primary peering location (one of the provider's
   * `peeringLocations`). Changing it replaces the peering service.
   */
  providerPrimaryPeeringLocation?: string;
  /**
   * The provider's backup peering location. Changing it replaces the
   * peering service.
   */
  providerBackupPeeringLocation?: string;
  /** SKU name of the peering service. Changing it replaces the peering service. */
  sku?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface PeeringService extends Resource<
  "Azure.Peering.PeeringService",
  PeeringServiceProps,
  {
    /** Name of the peering service. */
    peeringServiceName: string;
    /** Resource group that holds the peering service. */
    resourceGroup: string;
    /** ARM resource ID of the peering service. */
    peeringServiceId: string;
    /** Location of the ARM resource. */
    location: string;
    /** Customer location served by the peering service. */
    peeringServiceLocation: string;
    /** Partner provider of the peering service. */
    peeringServiceProvider: string;
    /** The provider's primary peering location. */
    providerPrimaryPeeringLocation: string | undefined;
    /** The provider's backup peering location. */
    providerBackupPeeringLocation: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Peering Service — a connection to Microsoft's network that is
 * routed through a certified Peering Service partner provider for a given
 * customer location. Register your provider-assigned IP prefixes on it
 * with `Azure.Peering.PeeringServicePrefix`.
 *
 * @see https://learn.microsoft.com/azure/peering-service/about
 *
 * ### Creating a Peering Service
 * **Example:** Peering service through a partner provider
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("network");
 * const service = yield* Azure.Peering.PeeringService("office", {
 *   resourceGroup: group.resourceGroupName,
 *   peeringServiceLocation: "Washington",
 *   peeringServiceProvider: "T-Mobile USA",
 *   providerPrimaryPeeringLocation: "San Jose",
 * });
 * ```
 *
 * **Example:** Primary and backup peering locations
 * ```typescript
 * const service = yield* Azure.Peering.PeeringService("office", {
 *   resourceGroup: group.resourceGroupName,
 *   peeringServiceLocation: "Washington",
 *   peeringServiceProvider: "T-Mobile USA",
 *   providerPrimaryPeeringLocation: "San Jose",
 *   providerBackupPeeringLocation: "Ashburn",
 *   tags: { team: "network" },
 * });
 * ```
 *
 * @resource
 */
export const PeeringService = Resource<PeeringService>(
  "Azure.Peering.PeeringService",
);

const toAttrs = (
  resourceGroup: string,
  name: string,
  service: peering.GetPeeringServiceResponse,
): PeeringService["Attributes"] => ({
  peeringServiceName: name,
  resourceGroup,
  peeringServiceId: service.id ?? "",
  location: service.location,
  peeringServiceLocation: service.properties?.peeringServiceLocation ?? "",
  peeringServiceProvider: service.properties?.peeringServiceProvider ?? "",
  providerPrimaryPeeringLocation:
    service.properties?.providerPrimaryPeeringLocation,
  providerBackupPeeringLocation:
    service.properties?.providerBackupPeeringLocation,
  provisioningState: service.properties?.provisioningState,
  tags: userTags(service.tags),
});

const differs = (a: string | undefined, b: string | undefined) =>
  a !== undefined && a.toLowerCase() !== (b ?? "").toLowerCase();

export const PeeringServiceProvider = () =>
  Provider.succeed(PeeringService, {
    stables: ["peeringServiceName", "resourceGroup", "peeringServiceId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* peering
        .ListPeeringServiceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPeeringServiceBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((service) => {
        const group = resourceGroupOf(service.id);
        return hasAnyAlchemyTag(service.tags) &&
          group !== undefined &&
          service.name !== undefined
          ? [toAttrs(group, service.name, service)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        differs(news.name, output.peeringServiceName) ||
        differs(news.location, output.location) ||
        differs(news.peeringServiceLocation, output.peeringServiceLocation) ||
        differs(news.peeringServiceProvider, output.peeringServiceProvider) ||
        (news.providerPrimaryPeeringLocation ?? "").toLowerCase() !==
          (output.providerPrimaryPeeringLocation ?? "").toLowerCase() ||
        (news.providerBackupPeeringLocation ?? "").toLowerCase() !==
          (output.providerBackupPeeringLocation ?? "").toLowerCase()
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
        output?.peeringServiceName ??
        olds?.name ??
        (yield* createPeeringName(id));
      const observed = yield* getPeeringService(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Peering");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.peeringServiceName ??
        (yield* createPeeringName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getPeeringService(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure: Azure rejects a PUT on an existing peering service, so the
      // PUT only creates. Everything but tags is immutable.
      if (observed === undefined) {
        yield* peering.PeeringServicesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          peeringServiceName: name,
          location: news.location ?? env.location,
          sku: news.sku !== undefined ? { name: news.sku } : undefined,
          properties: {
            peeringServiceLocation: news.peeringServiceLocation,
            peeringServiceProvider: news.peeringServiceProvider,
            providerPrimaryPeeringLocation: news.providerPrimaryPeeringLocation,
            providerBackupPeeringLocation: news.providerBackupPeeringLocation,
          },
          tags,
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        // Sync tags.
        yield* peering.UpdatePeeringService({
          subscriptionId,
          resourceGroupName: resourceGroup,
          peeringServiceName: name,
          tags,
        });
      }

      const fresh = yield* waitForProvisioned(
        `peering service ${name}`,
        get,
        (service) => service.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        peering.DeletePeeringService({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          peeringServiceName: output.peeringServiceName,
        }),
      );
      yield* waitUntilGone(
        `peering service ${output.peeringServiceName}`,
        getPeeringService(
          subscriptionId,
          output.resourceGroup,
          output.peeringServiceName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
