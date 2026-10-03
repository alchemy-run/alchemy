import * as migrate from "@distilled.cloud/azure/migrate";
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
import { migrateName, settingsDiffer } from "./Common.ts";

export interface MasterSiteProps {
  /** Resource group the site is created in. Changing it replaces the site. */
  resourceGroup: string;
  /**
   * Name of the site. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the site.
   */
  name?: string;
  /**
   * Azure location of the site. Azure Migrate serves a fixed set of
   * geographies (e.g. `centralus`, `westus2`, `westeurope`; not `eastus`).
   * Changing it replaces the site.
   * @default the `Azure.Location` layer, else the profile location
   */
  location?: string;
  /**
   * Whether the master site may group more than one fabric site.
   * @default false
   */
  allowMultipleSites?: boolean;
  /** ARM IDs of the fabric sites (VMware, Hyper-V, server) the master site groups. */
  sites?: string[];
  /**
   * Whether the site accepts traffic over the public endpoint.
   * @default "Enabled"
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /** ARM ID of the storage account used when public access is disabled. */
  customerStorageAccountArmId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface MasterSite extends Resource<
  "Azure.Migrate.MasterSite",
  MasterSiteProps,
  {
    /** Name of the site. */
    siteName: string;
    /** Resource group that holds the site. */
    resourceGroup: string;
    /** ARM resource ID of the site; use it as a collector's `discoverySiteId`. */
    siteId: string;
    /** Location of the site. */
    location: string;
    /** ARM IDs of the fabric sites the master site groups. */
    sites: string[];
    /** ARM IDs of the SQL and web-app sites nested under the master site. */
    nestedSites: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Migrate master site (`Microsoft.OffAzure/masterSites`) — groups
 * an appliance's fabric sites (VMware, Hyper-V, physical servers) together
 * with the SQL and web-app inventory sites the appliance creates under it.
 *
 * @see https://learn.microsoft.com/azure/migrate/migrate-appliance-architecture
 *
 * ### Creating a Site
 * **Example:** Master site
 * ```typescript
 * const site = yield* Azure.Migrate.MasterSite("master", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 * });
 * ```
 *
 * ### Grouping Fabric Sites
 * **Example:** Master site over a VMware site
 * ```typescript
 * const vmware = yield* Azure.Migrate.VmwareSite("vmware", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 * });
 * const master = yield* Azure.Migrate.MasterSite("master", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 *   allowMultipleSites: true,
 *   sites: [vmware.siteId],
 * });
 * ```
 *
 * @resource
 */
export const MasterSite = Resource<MasterSite>("Azure.Migrate.MasterSite");

type ObservedMasterSite = migrate.GetMasterSitesControllerResponse;

export const getMasterSite = (
  subscriptionId: string,
  resourceGroupName: string,
  siteName: string,
) =>
  orUndefinedIfNotFound(
    migrate.GetMasterSitesController({
      subscriptionId,
      resourceGroupName,
      siteName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  site: ObservedMasterSite,
): MasterSite["Attributes"] => ({
  siteName: name,
  resourceGroup,
  siteId: site.id ?? "",
  location: site.location,
  sites: [...(site.properties?.sites ?? [])],
  nestedSites: [...(site.properties?.nestedSites ?? [])],
  tags: userTags(site.tags),
});

const desiredProperties = (news: MasterSiteProps) => ({
  allowMultipleSites: news.allowMultipleSites,
  sites: news.sites,
  publicNetworkAccess: news.publicNetworkAccess,
  customerStorageAccountArmId: news.customerStorageAccountArmId,
});

export const MasterSiteProvider = () =>
  Provider.succeed(MasterSite, {
    stables: ["siteName", "resourceGroup", "siteId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* migrate
        .ListMasterSitesControllerBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListMasterSitesControllerBySubscription", page),
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
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.siteName.toLowerCase()) ||
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
      const name = output?.siteName ?? olds?.name ?? (yield* migrateName(id));
      const observed = yield* getMasterSite(
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
      yield* ensureRegistered(subscriptionId, "Microsoft.OffAzure");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.siteName ?? (yield* migrateName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const properties = desiredProperties(news);
      const get = getMasterSite(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a create-or-update of the whole site.
      if (
        observed === undefined ||
        tagsDiffer(observed.tags, tags) ||
        settingsDiffer(properties, observed.properties)
      ) {
        yield* migrate.CreateMasterSitesController({
          subscriptionId,
          resourceGroupName: resourceGroup,
          siteName: name,
          location: observed?.location ?? location,
          tags,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `master site ${name}`,
        get,
        (site) => site.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        migrate.DeleteMasterSitesController({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          siteName: output.siteName,
        }),
      );
      yield* waitUntilGone(
        `master site ${output.siteName}`,
        getMasterSite(subscriptionId, output.resourceGroup, output.siteName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
