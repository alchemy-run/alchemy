import * as web from "@distilled.cloud/azure/web";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { changedKeys, lower, reveal, sameLocation } from "./common.ts";

/** Static Web Apps pricing plan. */
export type StaticSiteSku = "Free" | "Standard" | "Dedicated";

export interface StaticSiteProps {
  /**
   * Resource group the static site is created in. Changing it replaces the
   * site.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
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
   * password protection, private endpoints, and an SLA. `Dedicated` runs
   * the site on dedicated infrastructure. Changes in place.
   * @default "Free"
   */
  sku?: StaticSiteSku;
  /**
   * Git repository Azure builds the site from, e.g.
   * `https://github.com/contoso/docs`. Omit it to deploy with the
   * deployment token instead ("bring your own CI").
   * @default no repository
   */
  repositoryUrl?: string;
  /** Branch of `repositoryUrl` to build, e.g. `main`. */
  branch?: string;
  /**
   * GitHub personal access token Azure uses to set up the repository
   * (a workflow and a deployment secret).
   */
  repositoryToken?: string | Redacted.Redacted<string>;
  /**
   * Build settings used when Azure builds `repositoryUrl`: `appLocation`,
   * `apiLocation`, `outputLocation`, and custom build commands.
   */
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
   * Whether the public endpoint accepts traffic. `Disabled` needs the
   * `Standard` plan and a private endpoint to reach the site.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * App settings exposed to the site's managed functions as environment
   * variables. The site's settings are replaced with exactly this map.
   * @default {}
   */
  appSettings?: Record<string, string>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
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
    /** Pricing plan: `Free`, `Standard`, or `Dedicated`. */
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
 * An Azure Static Web App (`Microsoft.Web/staticSites`): globally
 * distributed static content with optional managed functions, preview
 * environments, and custom domains.
 *
 * Alchemy creates a `Free` site in `eastus2` (not the stack's location:
 * Static Web Apps runs its management plane in five regions only). The
 * content itself is served from a global edge network. Without
 * `repositoryUrl` the site is "bring your own CI": upload content with the
 * `deploymentToken` (e.g. `swa deploy --deployment-token`). To build and
 * upload a site from the stack itself, use `Azure.Website.StaticSite`,
 * which serves from Blob Storage and Front Door instead.
 *
 * :::caution[Changing `name`, `resourceGroup`, or `location` replaces the site]
 * Alchemy creates a new, empty site with a new `*.azurestaticapps.net`
 * host name and a new deployment token, and deletes the old site with its
 * content and preview environments. Deploy the content again. Custom
 * domains move to the new site and validate again against its new host
 * name.
 * :::
 *
 * :::caution[Static Web Apps runs in `westus2`, `centralus`, `eastus2`, `westeurope`, and `eastasia` only]
 * A `location` outside these regions fails. Alchemy registers the
 * `Microsoft.Web` resource provider before the first site.
 * :::
 *
 * @see https://learn.microsoft.com/azure/static-web-apps/overview
 *
 * ### Creating a Static Site
 * **Example:** Free static site
 * ```typescript
 * const site = yield* Azure.Web.StaticSite("site");
 * // site.url, site.deploymentToken
 * ```
 *
 * **Example:** Site with a fixed name and region
 * ```typescript
 * const site = yield* Azure.Web.StaticSite("site", {
 *   name: "contoso-docs",
 *   location: "westeurope",
 *   tags: { team: "docs" },
 * });
 * ```
 *
 * **Example:** Standard site with app settings
 * ```typescript
 * const site = yield* Azure.Web.StaticSite("site", {
 *   sku: "Standard",
 *   stagingEnvironmentPolicy: "Disabled",
 *   appSettings: { API_BASE: "https://api.example.com" },
 * });
 * ```
 *
 * ### Deploying Content
 * **Example:** Deploy from your own CI with the deployment token
 * ```typescript
 * const site = yield* Azure.Web.StaticSite("site");
 * return { deploymentToken: site.deploymentToken };
 * // in CI: swa deploy ./dist --deployment-token "$SWA_DEPLOYMENT_TOKEN" --env production
 * ```
 *
 * **Example:** Let Azure build a GitHub repository
 * ```typescript
 * const site = yield* Azure.Web.StaticSite("site", {
 *   repositoryUrl: "https://github.com/contoso/docs",
 *   branch: "main",
 *   repositoryToken: Config.redacted("GITHUB_TOKEN"),
 *   buildProperties: {
 *     appLocation: "/",
 *     apiLocation: "api",
 *     outputLocation: "dist",
 *   },
 * });
 * ```
 *
 * ### Preview Environments
 * Each pull request gets its own preview URL unless you turn them off.
 * The `Free` plan allows 3 preview environments and `Standard` allows 10.
 *
 * **Example:** No preview environments, no config-file overrides
 * ```typescript
 * const site = yield* Azure.Web.StaticSite("site", {
 *   stagingEnvironmentPolicy: "Disabled",
 *   allowConfigFileUpdates: false,
 * });
 * ```
 *
 * **Example:** Password-protect the preview environments
 * ```typescript
 * const site = yield* Azure.Web.StaticSite("site", { sku: "Standard" });
 * yield* Azure.Web.StaticSiteBasicAuth("preview-password", {
 *   staticSiteName: site.staticSiteName,
 *   password: Redacted.make(previewPassword),
 *   applicableEnvironmentsMode: "StagingEnvironments",
 * });
 * ```
 *
 * **Example:** Settings of one preview environment
 * ```typescript
 * yield* Azure.Web.StaticSiteEnvironmentSettings("preview-settings", {
 *   staticSiteName: site.staticSiteName,
 *   environmentName: "42",
 *   appSettings: { API_URL: "https://preview.example.com" },
 * });
 * ```
 *
 * ### Custom Domains
 * **Example:** Subdomain validated by an Azure DNS CNAME record
 * ```typescript
 * const zone = yield* Azure.Dns.Zone("contoso", { name: "contoso.com" });
 * const site = yield* Azure.Web.StaticSite("site");
 * const cname = yield* Azure.Dns.RecordSet("www", {
 *   zoneName: zone.zoneName,
 *   recordType: "CNAME",
 *   name: "www",
 *   cname: site.defaultHostname,
 * });
 * yield* Azure.Web.StaticSiteCustomDomain("www", {
 *   staticSiteName: site.staticSiteName,
 *   domainName: Output.map(cname.recordSetName, () => "www.contoso.com"),
 * });
 * ```
 *
 * **Example:** Apex domain validated by a TXT token
 * ```typescript
 * const domain = yield* Azure.Web.StaticSiteCustomDomain("apex", {
 *   staticSiteName: site.staticSiteName,
 *   domainName: "contoso.com",
 *   validationMethod: "dns-txt-token",
 * });
 * yield* Azure.Dns.RecordSet("dnsauth", {
 *   zoneName: zone.zoneName,
 *   recordType: "TXT",
 *   name: "_dnsauth",
 *   txtRecords: [domain.validationToken.as<string>()],
 * });
 * ```
 *
 * ### APIs and Backends
 * On the `Standard` plan, link one backend to serve `/api/*`: a function
 * app, container app, API Management instance, or web app.
 *
 * **Example:** Container App behind `/api`
 * ```typescript
 * const site = yield* Azure.Web.StaticSite("site", { sku: "Standard" });
 * const api = yield* Azure.ContainerApps.ContainerApp("api", {
 *   environmentId: env.environmentId,
 *   configuration: { ingress: { external: true, targetPort: 80 } },
 *   template: {
 *     containers: [{ name: "api", image: "mcr.microsoft.com/k8se/quickstart:latest" }],
 *   },
 * });
 * yield* Azure.Web.StaticSiteLinkedBackend("api", {
 *   staticSiteName: site.staticSiteName,
 *   backendResourceId: api.containerAppId,
 *   region: api.location,
 * });
 * ```
 *
 * **Example:** Settings for the managed functions in `apiLocation`
 * ```typescript
 * const site = yield* Azure.Web.StaticSite("site", {
 *   appSettings: { DATABASE_URL: "postgres://db.example.com/app" },
 * });
 * ```
 *
 * ### Network Access
 * **Example:** Turn off the public endpoint
 * ```typescript
 * const site = yield* Azure.Web.StaticSite("site", {
 *   sku: "Standard",
 *   publicNetworkAccess: "Disabled",
 * });
 * const endpoint = yield* Azure.Network.PrivateEndpoint("site", {
 *   subnetId: subnet.subnetId,
 *   privateLinkServiceConnections: [
 *     { privateLinkServiceId: site.staticSiteId, groupIds: ["staticSites"] },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const StaticSite = GroupedResource<StaticSite>("Azure.Web.StaticSite");

type ObservedSite = web.GetStaticSiteStaticSiteResponse;

const createSiteName = (id: string) => createPhysicalName({ id, maxLength: 40, lowercase: true });

const getSite = (subscriptionId: string, resourceGroupName: string, name: string) =>
  orUndefinedIfNotFound(web.GetStaticSiteStaticSite({ subscriptionId, resourceGroupName, name }));

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
      const page = yield* collectAll(web.ListStaticSites, { subscriptionId });
      return (page.value ?? []).flatMap((site) => {
        const group = resourceGroupOf(site.id);
        return hasAnyAlchemyTag(site.tags) && group !== undefined && site.name !== undefined
          ? [toAttrs(group, site.name, site, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && lower(news.name) !== lower(output.staticSiteName)) ||
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
      const name = output?.staticSiteName ?? olds?.name ?? (yield* createSiteName(id));
      const observed = yield* getSite(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed, output?.deploymentToken);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.staticSiteName ?? (yield* createSiteName(id));
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
      if (lower(observed.sku?.name) !== lower(skuName) || tagsDiffer(observed.tags, tags)) {
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
        ...toAttrs(resourceGroup, name, observed, apiKey ? Redacted.make(apiKey) : undefined),
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
