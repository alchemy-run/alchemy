import * as edge from "@distilled.cloud/azure/edge";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { EDGE_WAIT, edgeState, sameJson } from "./EdgeShared.ts";

/** Physical address of an Azure Arc site. */
export interface SiteAddress {
  /** First line of the street address. */
  streetAddress1?: string;
  /** Second line of the street address. */
  streetAddress2?: string;
  /** City. */
  city?: string;
  /** State or province. */
  stateOrProvince?: string;
  /** Country. */
  country?: string;
  /** Postal or ZIP code. */
  postalCode?: string;
}

export interface SiteProps {
  /** Resource group the site is created in. Changing it replaces the site. */
  resourceGroup: string;
  /**
   * Name of the site. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the site.
   */
  name?: string;
  /** Display name of the site. */
  displayName?: string;
  /** Description of the site. */
  description?: string;
  /** Physical address of the site. */
  siteAddress?: SiteAddress;
  /**
   * User labels. Sites have no ARM tags, so Alchemy ownership markers
   * (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) are merged into the
   * labels.
   */
  labels?: Record<string, string>;
}

export interface Site extends Resource<
  "Azure.Edge.Site",
  SiteProps,
  {
    /** Name of the site. */
    siteName: string;
    /** Resource group that holds the site. */
    resourceGroup: string;
    /** ARM resource ID of the site. */
    siteId: string;
    /** Display name of the site. */
    displayName: string | undefined;
    /** Description of the site. */
    description: string | undefined;
    /** Physical address of the site. */
    siteAddress: SiteAddress | undefined;
    /** User labels (Alchemy ownership markers stripped). */
    labels: Record<string, string>;
    /** Provisioning state of the last operation. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc site manager site at resource-group scope. A site groups the
 * Arc resources of one physical location (a factory, a store) so they can
 * be monitored and managed together, and it is the hierarchy level that
 * workload orchestration contexts reference.
 *
 * Sites have no ARM tags; Alchemy records ownership in the site's labels.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/site-manager/overview
 *
 * ### Creating a Site
 * **Example:** Site with an address
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("edge");
 * const site = yield* Azure.Edge.Site("seattle", {
 *   resourceGroup: group.resourceGroupName,
 *   displayName: "Seattle plant",
 *   siteAddress: { city: "Seattle", country: "US" },
 * });
 * ```
 *
 * **Example:** Site with labels
 * ```typescript
 * const site = yield* Azure.Edge.Site("seattle", {
 *   resourceGroup: group.resourceGroupName,
 *   labels: { region: "west" },
 * });
 * ```
 *
 * @resource
 */
export const Site = Resource<Site>("Azure.Edge.Site");

const getSite = (
  subscriptionId: string,
  resourceGroupName: string,
  siteName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetSite({ subscriptionId, resourceGroupName, siteName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  site: edge.GetSiteResponse,
): Site["Attributes"] => ({
  siteName: name,
  resourceGroup,
  siteId: site.id ?? "",
  displayName: site.properties?.displayName,
  description: site.properties?.description,
  siteAddress: site.properties?.siteAddress,
  labels: userTags(site.properties?.labels),
  provisioningState: site.properties?.provisioningState,
});

const siteName = (id: string) => createPhysicalName({ id, maxLength: 63 });

export const SiteProvider = () =>
  Provider.succeed(Site, {
    stables: ["siteName", "resourceGroup", "siteId"],

    // Resource-group sites have no subscription-wide list; nuke removes
    // them with their resource group.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.siteName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.siteName ?? olds?.name ?? (yield* siteName(id));
      const observed = yield* getSite(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.properties?.labels))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.siteName ?? (yield* siteName(id));
      const labels = yield* desiredTags(id, news.labels);
      const get = getSite(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync. The PUT is a full upsert; PATCH merges labels and
      // cannot remove one, so any observed delta is one PUT.
      const props = observed?.properties;
      if (
        observed === undefined ||
        props?.displayName !== news.displayName ||
        props?.description !== news.description ||
        !sameJson(props?.siteAddress, news.siteAddress) ||
        tagsDiffer(props?.labels, labels)
      ) {
        yield* edge.SitesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          siteName: name,
          properties: {
            displayName: news.displayName,
            description: news.description,
            siteAddress: news.siteAddress,
            labels,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge site ${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteSite({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          siteName: output.siteName,
        }),
      );
      yield* waitUntilGone(
        `edge site ${output.siteName}`,
        getSite(subscriptionId, output.resourceGroup, output.siteName),
        EDGE_WAIT,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
