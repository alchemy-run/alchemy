import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
import { changedKeys, lower, reveal, sameLocation } from "./common.ts";

/** Static Web Apps pricing plan. */
export type StaticSiteSku = "Free" | "Standard" | "Dedicated";

export interface StaticSiteProps {
  /**
   * Resource group the static site is created in. Changing it replaces the
   * site.
   */
  resourceGroup: string;
  /**
   * Name of the static site: 1-40 letters, digits, and hyphens, unique
   * within the resource group. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the site.
   */
  name?: string;
  /**
   * Azure location of the site's management plane. Static Web Apps is only
   * available in `westus2`, `centralus`, `eastus2`, `westeurope`, and
   * `eastasia`. Changing it replaces the site.
   * @default "eastus2"
   */
  location?: string;
  /**
   * Pricing plan. `Standard` adds custom authentication, linked backends,
   * private endpoints, and an SLA.
   * @default "Free"
   */
  sku?: StaticSiteSku;
  /**
   * Git repository Azure builds the site from. Omit it to deploy with the
   * deployment token instead ("bring your own CI").
   */
  repositoryUrl?: string;
  /** Branch of `repositoryUrl` to build. */
  branch?: string;
  /** GitHub personal access token Azure uses to set up the repository. */
  repositoryToken?: string | Redacted.Redacted<string>;
  /** Build settings used when Azure builds `repositoryUrl`. */
  buildProperties?: web.StaticSiteBuildProperties;
  /**
   * Whether pull requests get preview (staging) environments.
   * @default Azure's default (`Enabled`)
   */
  stagingEnvironmentPolicy?: "Enabled" | "Disabled";
  /**
   * Whether `staticwebapp.config.json` may change the site configuration.
   * @default Azure's default (`true`)
   */
  allowConfigFileUpdates?: boolean;
  /**
   * Whether the public endpoint accepts traffic.
   * @default Azure's default
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * App settings exposed to the site's managed functions as environment
   * variables. The site's settings are replaced with exactly this map.
   */
  appSettings?: Record<string, string>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface StaticSite extends Resource<
  "Azure.Web.StaticSite",
  StaticSiteProps,
  {
    /** Name of the static site. */
    staticSiteName: string;
    /** ARM resource ID of the static site. */
    staticSiteId: string;
    /** Resource group that holds the static site. */
    resourceGroup: string;
    /** Location of the static site. */
    location: string;
    /** Pricing plan. */
    sku: string;
    /** Default host name, e.g. `{words}.azurestaticapps.net`. */
    defaultHostname: string;
    /** HTTPS URL of the default host name. */
    url: string;
    /** Custom domains attached to the site. */
    customDomains: string[];
    /** CDN endpoint serving the content. */
    contentDistributionEndpoint: string | undefined;
    /** Deployment token for uploading content (e.g. from CI). */
    deploymentToken: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Static Web App: globally distributed static content with
 * optional managed functions, preview environments, and custom domains.
 *
 * Without `repositoryUrl` the site is "bring your own CI": upload content
 * with the `deploymentToken` (e.g. `swa deploy --deployment-token`).
 *
 * @see https://learn.microsoft.com/azure/static-web-apps/overview
 *
 * ### Creating a Static Site
 * **Example:** Free static site
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("web", {
 *   location: "eastus2",
 * });
 * const site = yield* Azure.Web.StaticSite("site", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // site.url, site.deploymentToken
 * ```
 *
 * **Example:** Standard site with app settings
 * ```typescript
 * const site = yield* Azure.Web.StaticSite("site", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard",
 *   stagingEnvironmentPolicy: "Disabled",
 *   appSettings: { API_BASE: "https://api.example.com" },
 * });
 * ```
 *
 * @resource
 */
export const StaticSite = Resource<StaticSite>("Azure.Web.StaticSite");

type ObservedSite = web.GetStaticSiteStaticSiteResponse;

const createSiteName = (id: string) =>
  createPhysicalName({ id, maxLength: 40, lowercase: true });

const getSite = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    web.GetStaticSiteStaticSite({ subscriptionId, resourceGroupName, name }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  site: ObservedSite,
  deploymentToken: Redacted.Redacted<string> | undefined,
): StaticSite["Attributes"] => {
  const host = site.properties?.defaultHostname ?? "";
  return {
    staticSiteName: name,
    staticSiteId: site.id ?? "",
    resourceGroup,
    location: site.location,
    sku: site.sku?.name ?? "",
    defaultHostname: host,
    url: host ? `https://${host}` : "",
    customDomains: [...(site.properties?.customDomains ?? [])],
    contentDistributionEndpoint: site.properties?.contentDistributionEndpoint,
    deploymentToken,
    tags: userTags(site.tags),
  };
};

const settingsMatch = (
  desired: Record<string, string>,
  observed: Record<string, string | undefined> | undefined,
) => {
  const have = observed ?? {};
  const keys = new Set([...Object.keys(desired), ...Object.keys(have)]);
  return [...keys].every((key) => desired[key] === have[key]);
};

export const StaticSiteProvider = () =>
  Provider.succeed(StaticSite, {
    stables: [
      "staticSiteName",
      "staticSiteId",
      "resourceGroup",
      "location",
      "defaultHostname",
      "url",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* web
        .ListStaticSites({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListStaticSites", page)),
        );
      return (page.value ?? []).flatMap((site) => {
        const group = resourceGroupOf(site.id);
        return hasAnyAlchemyTag(site.tags) &&
          group !== undefined &&
          site.name !== undefined
          ? [toAttrs(group, site.name, site, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.staticSiteName)) ||
        !sameLocation(news.location ?? "eastus2", output.location)
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
        output?.staticSiteName ?? olds?.name ?? (yield* createSiteName(id));
      const observed = yield* getSite(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        name,
        observed,
        output?.deploymentToken,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.staticSiteName ?? (yield* createSiteName(id));
      const location = news.location ?? output?.location ?? "eastus2";
      const tags = yield* desiredTags(id, news.tags);
      const skuName = news.sku ?? "Free";
      const properties = {
        repositoryUrl: news.repositoryUrl,
        branch: news.branch,
        buildProperties: news.buildProperties,
        stagingEnvironmentPolicy: news.stagingEnvironmentPolicy,
        allowConfigFileUpdates: news.allowConfigFileUpdates,
        publicNetworkAccess: news.publicNetworkAccess,
      };
      const where = { subscriptionId, resourceGroupName: resourceGroup, name };
      const label = `static site ${name}`;
      const get = getSite(subscriptionId, resourceGroup, name);
      // The site has no provisioningState: it is ready once it has a host.
      const waitReady = waitForProvisioned(
        label,
        get,
        (site) => (site.properties?.defaultHostname ? undefined : "InProgress"),
        { interval: "3 seconds", times: 60 },
      );
      const put = web.StaticSitesCreateOrUpdateStaticSite({
        ...where,
        location,
        tags,
        sku: { name: skuName, tier: skuName },
        properties: {
          ...properties,
          repositoryToken: reveal(news.repositoryToken),
        },
      });

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* put;
      }
      observed = yield* waitReady;

      // Sync the SKU, tags, and site properties. The PATCH body carries
      // neither SKU nor tags (and Microsoft.Web rejects the generic tags
      // API), so either delta re-sends the full PUT.
      const changed = changedKeys(properties, observed.properties);
      if (
        lower(observed.sku?.name) !== lower(skuName) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* put;
        observed = yield* waitReady;
      } else if (Object.keys(changed).length > 0) {
        yield* web.UpdateStaticSiteStaticSite({
          ...where,
          properties: changed,
        });
        observed = yield* waitReady;
      }

      // Sync app settings (full replace) against the observed settings.
      const appSettings = news.appSettings ?? {};
      const settings = yield* web.ListStaticSiteStaticSiteAppSettings(where);
      if (!settingsMatch(appSettings, settings.properties)) {
        yield* web.StaticSitesCreateOrUpdateStaticSiteAppSettings({
          ...where,
          properties: appSettings,
        });
      }

      const secrets = yield* web.ListStaticSiteStaticSiteSecrets(where);
      const apiKey = secrets.properties?.apiKey;
      return {
        ...toAttrs(
          resourceGroup,
          name,
          observed,
          apiKey ? Redacted.make(apiKey) : undefined,
        ),
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteStaticSiteStaticSite({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          name: output.staticSiteName,
        }),
      );
      yield* waitUntilGone(
        `static site ${output.staticSiteName}`,
        getSite(subscriptionId, output.resourceGroup, output.staticSiteName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
