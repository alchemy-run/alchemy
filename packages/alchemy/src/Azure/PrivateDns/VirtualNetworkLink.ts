import * as privatedns from "@distilled.cloud/azure/privatedns";
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
  resourceGroupOf,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  desiredMetadata,
  GLOBAL,
  hasAnyMarker,
  ownsMetadata,
  PRIVATE_DNS_BUDGET,
  sameArm,
  sameMap,
  userMetadata,
} from "./Common.ts";

export type ResolutionPolicy = "Default" | "NxDomainRedirect";

export interface VirtualNetworkLinkProps {
  /** Resource group of the zone. Changing it replaces the link. */
  resourceGroup: string;
  /** Name of the private DNS zone. Changing it replaces the link. */
  privateZoneName: string;
  /**
   * Link name: 1-80 letters, digits, `_`, `-`, and `.`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the link.
   */
  name?: string;
  /**
   * ARM ID of the virtual network to link. Changing it replaces the link.
   */
  virtualNetworkId: string;
  /**
   * Auto-register DNS records for virtual machines in the linked virtual
   * network. A virtual network can have only one registration-enabled
   * link.
   * @default false
   */
  registrationEnabled?: boolean;
  /**
   * With `NxDomainRedirect`, queries that return NXDOMAIN from the zone
   * fall back to public resolution. Only applies to Private Link
   * (`privatelink.*`) zones and A/AAAA/CNAME queries.
   * When omitted, the policy is not managed (Azure uses `Default`).
   */
  resolutionPolicy?: ResolutionPolicy;
  /**
   * User tags. Alchemy ownership tags (`alchemy_stack`, `alchemy_stage`,
   * `alchemy_id`) are merged in automatically; Private DNS drops tag keys
   * containing `:`.
   */
  tags?: Record<string, string>;
}

export interface VirtualNetworkLink extends Resource<
  "Azure.PrivateDns.VirtualNetworkLink",
  VirtualNetworkLinkProps,
  {
    /** Name of the link. */
    virtualNetworkLinkName: string;
    /** ARM resource ID of the link. */
    virtualNetworkLinkId: string;
    /** Name of the zone the link belongs to. */
    privateZoneName: string;
    /** Resource group of the zone. */
    resourceGroup: string;
    /** ARM ID of the linked virtual network. */
    virtualNetworkId: string;
    /** Whether VM records are auto-registered in the zone. */
    registrationEnabled: boolean;
    /** Resolution policy of the link. */
    resolutionPolicy: ResolutionPolicy;
    /** Link state (`InProgress` or `Completed`). */
    virtualNetworkLinkState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A link between an Azure Private DNS zone and a virtual network: resources
 * in the virtual network resolve the zone's records, and VMs can
 * auto-register their own records.
 *
 * @see https://learn.microsoft.com/azure/dns/private-dns-virtual-network-links
 *
 * ### Linking a Virtual Network
 * **Example:** Resolution-only link
 * ```typescript
 * const link = yield* Azure.PrivateDns.VirtualNetworkLink("hub", {
 *   resourceGroup: group.resourceGroupName,
 *   privateZoneName: zone.privateZoneName,
 *   virtualNetworkId: vnet.virtualNetworkId,
 * });
 * ```
 *
 * ### Auto-Registration
 * **Example:** Register VM records in the zone
 * ```typescript
 * yield* Azure.PrivateDns.VirtualNetworkLink("workloads", {
 *   resourceGroup: group.resourceGroupName,
 *   privateZoneName: zone.privateZoneName,
 *   virtualNetworkId: vnet.virtualNetworkId,
 *   registrationEnabled: true,
 * });
 * ```
 *
 * ### Private Link Fallback
 * **Example:** Fall back to public DNS for unknown names
 * ```typescript
 * yield* Azure.PrivateDns.VirtualNetworkLink("blob", {
 *   resourceGroup: group.resourceGroupName,
 *   privateZoneName: blobZone.privateZoneName,
 *   virtualNetworkId: vnet.virtualNetworkId,
 *   resolutionPolicy: "NxDomainRedirect",
 * });
 * ```
 *
 * @resource
 */
export const VirtualNetworkLink = Resource<VirtualNetworkLink>(
  "Azure.PrivateDns.VirtualNetworkLink",
);

const createLinkName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 80 });
  return name
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9_]+$/g, "");
});

const getLink = (
  subscriptionId: string,
  resourceGroupName: string,
  privateZoneName: string,
  virtualNetworkLinkName: string,
) =>
  orUndefinedIfNotFound(
    privatedns.GetVirtualNetworkLink({
      subscriptionId,
      resourceGroupName,
      privateZoneName,
      virtualNetworkLinkName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  zoneName: string,
  name: string,
  link:
    | privatedns.GetVirtualNetworkLinkResponse
    | privatedns.VirtualNetworkLink,
): VirtualNetworkLink["Attributes"] => ({
  virtualNetworkLinkName: name,
  virtualNetworkLinkId: link.id ?? "",
  privateZoneName: zoneName,
  resourceGroup,
  virtualNetworkId: link.properties?.virtualNetwork?.id ?? "",
  registrationEnabled: link.properties?.registrationEnabled ?? false,
  resolutionPolicy: (link.properties?.resolutionPolicy ??
    "Default") as ResolutionPolicy,
  virtualNetworkLinkState: link.properties?.virtualNetworkLinkState,
  tags: userMetadata(link.tags),
});

/** Provisioned and the link to the virtual network is established. */
const linkState = (
  link: privatedns.GetVirtualNetworkLinkResponse,
): string | undefined => {
  const state = link.properties?.provisioningState;
  if (state !== undefined && state !== "Succeeded") return state;
  return link.properties?.virtualNetworkLinkState === "InProgress"
    ? "InProgress"
    : state;
};

export const VirtualNetworkLinkProvider = () =>
  Provider.succeed(VirtualNetworkLink, {
    stables: [
      "virtualNetworkLinkName",
      "virtualNetworkLinkId",
      "privateZoneName",
      "resourceGroup",
      "virtualNetworkId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const zones = yield* privatedns
        .ListPrivateZones({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListPrivateZones", page)),
        );
      const found: VirtualNetworkLink["Attributes"][] = [];
      for (const zone of zones.value ?? []) {
        const group = resourceGroupOf(zone.id);
        if (group === undefined || zone.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          privatedns.ListVirtualNetworkLinks({
            subscriptionId,
            resourceGroupName: group,
            privateZoneName: zone.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage("ListVirtualNetworkLinks", page);
        }
        for (const link of page?.value ?? []) {
          if (hasAnyMarker(link.tags) && link.name !== undefined) {
            found.push(toAttrs(group, zone.name, link.name, link));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameZone =
        sameArm(news.resourceGroup, output.resourceGroup) &&
        sameArm(news.privateZoneName, output.privateZoneName);
      if (
        !sameZone ||
        (news.name !== undefined &&
          !sameArm(news.name, output.virtualNetworkLinkName)) ||
        !sameArm(news.virtualNetworkId, output.virtualNetworkId)
      ) {
        // A zone can be linked to a virtual network only once.
        return {
          action: "replace",
          deleteFirst:
            sameZone && sameArm(news.virtualNetworkId, output.virtualNetworkId),
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const zoneName = output?.privateZoneName ?? olds?.privateZoneName;
      if (resourceGroup === undefined || zoneName === undefined) {
        return undefined;
      }
      const name =
        output?.virtualNetworkLinkName ??
        olds?.name ??
        (yield* createLinkName(id));
      const observed = yield* getLink(
        subscriptionId,
        resourceGroup,
        zoneName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, zoneName, name, observed);
      return (yield* ownsMetadata(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const { resourceGroup, privateZoneName: zoneName } = news;
      const name =
        news.name ??
        output?.virtualNetworkLinkName ??
        (yield* createLinkName(id));
      const tags = yield* desiredMetadata(id, news.tags);
      const registrationEnabled = news.registrationEnabled ?? false;
      // Only Private Link zones accept a resolution policy; omit it otherwise.
      const resolutionPolicy = news.resolutionPolicy;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        privateZoneName: zoneName,
        virtualNetworkLinkName: name,
      };
      const get = getLink(subscriptionId, resourceGroup, zoneName, name);
      const label = `private DNS virtual network link ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* privatedns.VirtualNetworkLinksCreateOrUpdate({
          ...where,
          location: GLOBAL,
          tags,
          properties: {
            virtualNetwork: { id: news.virtualNetworkId },
            registrationEnabled,
            resolutionPolicy,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        linkState,
        PRIVATE_DNS_BUDGET,
      );

      // Sync mutable aspects against observed state; PATCH only deltas.
      const drift = (link: privatedns.GetVirtualNetworkLinkResponse) => ({
        registration:
          (link.properties?.registrationEnabled ?? false) !==
          registrationEnabled,
        policy:
          resolutionPolicy !== undefined &&
          (link.properties?.resolutionPolicy ?? "Default") !== resolutionPolicy,
        tags: !sameMap(link.tags, tags),
      });
      const delta = drift(observed);
      if (delta.registration || delta.policy || delta.tags) {
        yield* privatedns.UpdateVirtualNetworkLink({
          ...where,
          properties:
            delta.registration || delta.policy
              ? {
                  registrationEnabled: delta.registration
                    ? registrationEnabled
                    : undefined,
                  resolutionPolicy: delta.policy ? resolutionPolicy : undefined,
                }
              : undefined,
          tags: delta.tags ? tags : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (link) => {
            const d = drift(link);
            return d.registration || d.policy || d.tags
              ? "Updating"
              : linkState(link);
          },
          PRIVATE_DNS_BUDGET,
        );
      }

      return toAttrs(resourceGroup, zoneName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        privatedns.DeleteVirtualNetworkLink({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateZoneName: output.privateZoneName,
          virtualNetworkLinkName: output.virtualNetworkLinkName,
        }),
      );
      yield* waitUntilGone(
        `private DNS virtual network link ${output.virtualNetworkLinkName}`,
        getLink(
          subscriptionId,
          output.resourceGroup,
          output.privateZoneName,
          output.virtualNetworkLinkName,
        ),
        PRIVATE_DNS_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.PrivateDns.Zone",
        "Azure.Network.VirtualNetwork",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
