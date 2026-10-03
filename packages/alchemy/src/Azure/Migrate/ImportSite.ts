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

export interface ImportSiteProps {
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
  /** ARM ID of the `Migrate.Solution` (discovery tool) that tracks this site. */
  discoverySolutionId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ImportSite extends Resource<
  "Azure.Migrate.ImportSite",
  ImportSiteProps,
  {
    /** Name of the site. */
    siteName: string;
    /** Resource group that holds the site. */
    resourceGroup: string;
    /** ARM resource ID of the site; use it as a collector's `discoverySiteId`. */
    siteId: string;
    /** Location of the site. */
    location: string;
    /** Discovery service endpoint of the site. */
    serviceEndpoint: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Migrate import site (`Microsoft.OffAzure/importSites`) — the
 * discovery container for machine inventory imported from a CSV file
 * instead of an on-premises appliance. Pair it with a
 * `Migrate.ImportCollector` in an assessment project.
 *
 * @see https://learn.microsoft.com/azure/migrate/tutorial-discover-import
 *
 * ### Creating a Site
 * **Example:** Discovery site
 * ```typescript
 * const site = yield* Azure.Migrate.ImportSite("imports", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 * });
 * ```
 *
 * @resource
 */
export const ImportSite = Resource<ImportSite>("Azure.Migrate.ImportSite");

type ObservedImportSite = migrate.GetImportSitesControllerResponse;

export const getImportSite = (
  subscriptionId: string,
  resourceGroupName: string,
  siteName: string,
) =>
  orUndefinedIfNotFound(
    migrate.GetImportSitesController({
      subscriptionId,
      resourceGroupName,
      siteName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  site: ObservedImportSite,
): ImportSite["Attributes"] => ({
  siteName: name,
  resourceGroup,
  siteId: site.id ?? "",
  location: site.location,
  serviceEndpoint: site.properties?.serviceEndpoint ?? "",
  tags: userTags(site.tags),
});

const desiredProperties = (news: ImportSiteProps) => ({
  discoverySolutionId: news.discoverySolutionId,
});

export const ImportSiteProvider = () =>
  Provider.succeed(ImportSite, {
    stables: ["siteName", "resourceGroup", "siteId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* migrate
        .ListImportSitesControllerBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListImportSitesControllerBySubscription", page),
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
      const observed = yield* getImportSite(
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
      const get = getImportSite(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a create-or-update of the whole site.
      if (
        observed === undefined ||
        tagsDiffer(observed.tags, tags) ||
        settingsDiffer(properties, observed.properties)
      ) {
        yield* migrate.CreateImportSitesController({
          subscriptionId,
          resourceGroupName: resourceGroup,
          siteName: name,
          location: observed?.location ?? location,
          tags,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `import site ${name}`,
        get,
        (site) => site.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        migrate.DeleteImportSitesController({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          siteName: output.siteName,
        }),
      );
      yield* waitUntilGone(
        `import site ${output.siteName}`,
        getImportSite(subscriptionId, output.resourceGroup, output.siteName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
