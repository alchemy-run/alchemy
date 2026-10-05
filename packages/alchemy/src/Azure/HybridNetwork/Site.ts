import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
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
import {
  canonical,
  createHybridNetworkName,
  FAST_BUDGET,
  NAMESPACE,
  retryInProgress,
  sameArm,
} from "./Common.ts";

export type SiteNfviType =
  | "AzureCore"
  | "AzureArcKubernetes"
  | "AzureOperatorNexus";

export interface SiteNfvi {
  /** Name of the NFVI, referenced by network service designs. */
  name: string;
  /** NFVI kind. */
  nfviType: SiteNfviType;
  /** Azure location of an `AzureCore` NFVI. */
  location?: string;
  /**
   * ARM ID of the custom location of an `AzureArcKubernetes` or
   * `AzureOperatorNexus` NFVI.
   */
  customLocationId?: string;
}

export interface SiteProps {
  /** Resource group the site is created in. Changing it replaces the site. */
  resourceGroup: string;
  /**
   * Site name: 1-64 letters, digits, `_`, and `-`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the site.
   */
  name?: string;
  /**
   * Azure location of the site resource. Changing it replaces the site.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Network function virtualization infrastructures (NFVIs) of the site. */
  nfvis?: SiteNfvi[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Site extends Resource<
  "Azure.HybridNetwork.Site",
  SiteProps,
  {
    /** Name of the site. */
    siteName: string;
    /** ARM resource ID of the site. */
    siteId: string;
    /** Resource group that holds the site. */
    resourceGroup: string;
    /** Location of the site resource. */
    location: string;
    /** NFVIs of the site. */
    nfvis: SiteNfvi[];
    /** ARM IDs of site network services deployed to the site. */
    siteNetworkServiceIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Service Manager site — an operator's logical grouping
 * of network function virtualization infrastructures (Azure regions,
 * Arc-enabled Kubernetes clusters, or Azure Operator Nexus clusters) that
 * site network services deploy to.
 *
 * Sites are free metadata resources.
 *
 * @see https://learn.microsoft.com/azure/operator-service-manager/site-overview
 *
 * ### Creating a Site
 * **Example:** Site with an Azure core NFVI
 * ```typescript
 * const site = yield* Azure.HybridNetwork.Site("site", {
 *   resourceGroup: group.resourceGroupName,
 *   nfvis: [{ name: "azure-eastus", nfviType: "AzureCore", location: "eastus" }],
 * });
 * ```
 *
 * **Example:** Site with an Arc-enabled Kubernetes NFVI
 * ```typescript
 * const site = yield* Azure.HybridNetwork.Site("edge", {
 *   resourceGroup: group.resourceGroupName,
 *   nfvis: [
 *     {
 *       name: "edge-cluster",
 *       nfviType: "AzureArcKubernetes",
 *       customLocationId: customLocation.id,
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const Site = Resource<Site>("Azure.HybridNetwork.Site");

const getSite = (
  subscriptionId: string,
  resourceGroupName: string,
  siteName: string,
) =>
  orUndefinedIfNotFound(
    hybridnetwork.GetSite({ subscriptionId, resourceGroupName, siteName }),
  );

const fromNfvi = (nfvi: hybridnetwork.NFVIs): SiteNfvi => {
  const ref = nfvi.customLocationReference as { id?: string } | undefined;
  return {
    name: nfvi.name ?? "",
    nfviType: nfvi.nfviType as SiteNfviType,
    ...(nfvi.location !== undefined ? { location: nfvi.location } : {}),
    ...(ref?.id !== undefined ? { customLocationId: ref.id } : {}),
  };
};

const toNfvi = (nfvi: SiteNfvi) => ({
  name: nfvi.name,
  nfviType: nfvi.nfviType,
  location: nfvi.location,
  customLocationReference:
    nfvi.customLocationId === undefined
      ? undefined
      : { id: nfvi.customLocationId },
});

const nfviKey = (nfvis: ReadonlyArray<SiteNfvi>) =>
  canonical(
    nfvis.map((n) => ({
      name: n.name,
      nfviType: n.nfviType,
      location: n.location?.toLowerCase(),
      customLocationId: n.customLocationId?.toLowerCase(),
    })),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  site: hybridnetwork.GetSiteResponse | hybridnetwork.Site,
): Site["Attributes"] => ({
  siteName: name,
  siteId: site.id ?? "",
  resourceGroup,
  location: site.location,
  nfvis: (site.properties?.nfvis ?? []).map(fromNfvi),
  siteNetworkServiceIds: (site.properties?.siteNetworkServiceReferences ?? [])
    .map((ref) => ref.id)
    .filter((id): id is string => id !== undefined),
  tags: userTags(site.tags),
});

export const SiteProvider = () =>
  Provider.succeed(Site, {
    stables: ["siteName", "siteId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* hybridnetwork
        .ListSiteBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListSiteBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((site) => {
        const group = resourceGroupOf(site.id);
        return hasAnyAlchemyTag(site.tags) &&
          group !== undefined &&
          site.name !== undefined
          ? [toAttrs(group, site.name, site)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.siteName) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location))
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
        output?.siteName ?? olds?.name ?? (yield* createHybridNetworkName(id));
      const observed = yield* getSite(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.siteName ?? (yield* createHybridNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const nfvis = news.nfvis ?? [];
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        siteName: name,
      };
      const get = getSite(subscriptionId, resourceGroup, name);
      const label = `AOSM site ${name}`;
      const nfvisDiffer = (site: hybridnetwork.GetSiteResponse) =>
        nfviKey((site.properties?.nfvis ?? []).map(fromNfvi)) !==
        nfviKey(nfvis);

      // Observe.
      let observed = yield* get;

      // Ensure (and sync NFVIs, which are only writable by PUT).
      if (observed === undefined || nfvisDiffer(observed)) {
        yield* retryInProgress(
          hybridnetwork.SitesCreateOrUpdate({
            ...where,
            location: observed?.location ?? location,
            tags,
            properties: { nfvis: nfvis.map(toNfvi) },
          }),
        );
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (site) =>
          nfvisDiffer(site) ? "Updating" : site.properties?.provisioningState,
        FAST_BUDGET,
      );

      // Sync tags against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* retryInProgress(
          hybridnetwork.UpdateSiteTags({ ...where, tags }),
        );
        observed = yield* waitForProvisioned(
          label,
          get,
          (site) =>
            tagsDiffer(site.tags, tags)
              ? "Updating"
              : site.properties?.provisioningState,
          FAST_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridnetwork.DeleteSite({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          siteName: output.siteName,
        }),
      );
      yield* waitUntilGone(
        `AOSM site ${output.siteName}`,
        getSite(subscriptionId, output.resourceGroup, output.siteName),
        FAST_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
