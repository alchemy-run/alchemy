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
import type { SiteAgentKeyVault, SiteServicePrincipal } from "./Types.ts";

export interface VmwareSiteProps {
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
  /** Name of the Azure Migrate appliance that reports to this site. */
  applianceName?: string;
  /** ARM ID of the `Migrate.Solution` (discovery tool) that tracks this site. */
  discoverySolutionId?: string;
  /** Microsoft Entra application the appliance authenticates with. */
  servicePrincipalIdentityDetails?: SiteServicePrincipal;
  /** Key Vault the appliance agent stores its secrets in. */
  agentDetails?: SiteAgentKeyVault;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface VmwareSite extends Resource<
  "Azure.Migrate.VmwareSite",
  VmwareSiteProps,
  {
    /** Name of the site. */
    siteName: string;
    /** Resource group that holds the site. */
    resourceGroup: string;
    /** ARM resource ID of the site; use it as a collector's `discoverySiteId`. */
    siteId: string;
    /** Location of the site. */
    location: string;
    /** Discovery service endpoint the appliance reports to. */
    serviceEndpoint: string;
    /**
     * ID of the appliance agent Azure assigned to the site. Assessment
     * collectors register with it as their `agentId`.
     */
    agentId: string;
    /** Name of the appliance reporting to the site, if set. */
    applianceName: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Migrate VMware discovery site (`Microsoft.OffAzure/vmwareSites`) — the discovery container an
 * on-premises Azure Migrate appliance reports VMware vSphere inventory to.
 *
 * @see https://learn.microsoft.com/azure/migrate/how-to-set-up-appliance-vmware
 *
 * ### Creating a Site
 * **Example:** Discovery site
 * ```typescript
 * const site = yield* Azure.Migrate.VmwareSite("vmware", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 * });
 * ```
 *
 * ### Registering an Appliance
 * **Example:** Site with an appliance and its service principal
 * ```typescript
 * const site = yield* Azure.Migrate.VmwareSite("vmware", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 *   applianceName: "onprem-appliance",
 *   servicePrincipalIdentityDetails: {
 *     tenantId: "<tenant-id>",
 *     applicationId: "<app-id>",
 *     objectId: "<object-id>",
 *     audience: "<app-id>",
 *     aadAuthority: "https://login.windows.net/<tenant-id>",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const VmwareSite = Resource<VmwareSite>("Azure.Migrate.VmwareSite");

type ObservedVmwareSite = migrate.GetSitesControllerResponse;

export const getVmwareSite = (
  subscriptionId: string,
  resourceGroupName: string,
  siteName: string,
) =>
  orUndefinedIfNotFound(
    migrate.GetSitesController({ subscriptionId, resourceGroupName, siteName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  site: ObservedVmwareSite,
): VmwareSite["Attributes"] => ({
  siteName: name,
  resourceGroup,
  siteId: site.id ?? "",
  location: site.location,
  serviceEndpoint: site.properties?.serviceEndpoint ?? "",
  agentId: site.properties?.agentDetails?.id ?? "",
  applianceName: site.properties?.applianceName ?? undefined,
  tags: userTags(site.tags),
});

const desiredProperties = (news: VmwareSiteProps) => ({
  applianceName: news.applianceName,
  discoverySolutionId: news.discoverySolutionId,
  servicePrincipalIdentityDetails: news.servicePrincipalIdentityDetails,
  agentDetails: news.agentDetails,
});

// The service does not echo the certificate back; never diff on it.
const comparable = (properties: ReturnType<typeof desiredProperties>) => ({
  ...properties,
  servicePrincipalIdentityDetails:
    properties.servicePrincipalIdentityDetails === undefined
      ? undefined
      : {
          ...properties.servicePrincipalIdentityDetails,
          rawCertData: undefined,
        },
});

export const VmwareSiteProvider = () =>
  Provider.succeed(VmwareSite, {
    stables: ["siteName", "resourceGroup", "siteId", "location", "agentId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* migrate
        .ListSitesControllerBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListSitesControllerBySubscription", page),
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
      const observed = yield* getVmwareSite(
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
      const get = getVmwareSite(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a create-or-update of the whole site.
      if (
        observed === undefined ||
        tagsDiffer(observed.tags, tags) ||
        settingsDiffer(comparable(properties), observed.properties)
      ) {
        yield* migrate.CreateSitesController({
          subscriptionId,
          resourceGroupName: resourceGroup,
          siteName: name,
          location: observed?.location ?? location,
          tags,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `VMware discovery site ${name}`,
        get,
        (site) => site.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        migrate.DeleteSitesController({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          siteName: output.siteName,
        }),
      );
      yield* waitUntilGone(
        `VMware discovery site ${output.siteName}`,
        getVmwareSite(subscriptionId, output.resourceGroup, output.siteName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
