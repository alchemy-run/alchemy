import * as migrate from "@distilled.cloud/azure/migrate";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { migrateName, ownedByStage, settingsDiffer } from "./Common.ts";
import { getHypervSite } from "./HypervSite.ts";

export interface HypervClusterProps {
  /** Resource group of the Hyper-V site. Changing it replaces the Hyper-V cluster. */
  resourceGroup: string;
  /** Hyper-V site the Hyper-V cluster belongs to. Changing it replaces the Hyper-V cluster. */
  hypervSite: string;
  /**
   * Name of the Hyper-V cluster in the site. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the Hyper-V cluster.
   */
  name?: string;
  /** Fully qualified domain name (or IP address) of the Hyper-V cluster. */
  fqdn: string;
  /**
   * ARM ID of the run-as account (credentials) the site's appliance uses to
   * connect. Run-as accounts are registered by the appliance; the service
   * rejects unknown IDs with `MigrateRunAsAccountInvalid`.
   */
  runAsAccountId: string;
  /** FQDNs of the cluster's member hosts. */
  hostFqdnList?: string[];
}

export interface HypervCluster extends Resource<
  "Azure.Migrate.HypervCluster",
  HypervClusterProps,
  {
    /** Name of the Hyper-V cluster in the site. */
    clusterName: string;
    /** Hyper-V site the Hyper-V cluster belongs to. */
    hypervSite: string;
    /** Resource group of the site. */
    resourceGroup: string;
    /** ARM resource ID of the Hyper-V cluster. */
    clusterId: string;
    /** Fully qualified domain name of the Hyper-V cluster. */
    fqdn: string;
    /** Cluster status the appliance reported, once it connected. */
    status: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Migrate Hyper-V cluster (`Microsoft.OffAzure/hypervSites/clusters`) — a Hyper-V failover cluster the site's appliance discovers VMs from.
 *
 * The appliance registered with the site must be able to reach the
 * Hyper-V cluster with the referenced run-as account; without a running appliance
 * Azure rejects the request. Hyper-V cluster entries cannot be tagged; Alchemy
 * treats one as owned when its site carries this stack's and stage's
 * ownership tags.
 *
 * @see https://learn.microsoft.com/azure/migrate/migrate-appliance-architecture
 *
 * ### Adding a Hyper-V cluster
 * **Example:** Hyper-V cluster discovered by an appliance
 * ```typescript
 * const cluster = yield* Azure.Migrate.HypervCluster("cluster", {
 *   resourceGroup: group.resourceGroupName,
 *   hypervSite: site.siteName,
 *   fqdn: "hvcluster.contoso.local",
 *   hostFqdnList: ["hyperv01.contoso.local", "hyperv02.contoso.local"],
 *   runAsAccountId: "<run-as account ARM ID registered by the appliance>",
 * });
 * ```
 *
 * @resource
 */
export const HypervCluster = Resource<HypervCluster>(
  "Azure.Migrate.HypervCluster",
);

const getHypervCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  siteName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    migrate.GetHypervClusterControllerCluster({
      subscriptionId,
      resourceGroupName,
      siteName,
      clusterName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  site: string,
  name: string,
  observed: migrate.GetHypervClusterControllerClusterResponse,
): HypervCluster["Attributes"] => ({
  clusterName: name,
  hypervSite: site,
  resourceGroup,
  clusterId: observed.id ?? "",
  fqdn: observed.properties?.fqdn ?? "",
  status: observed.properties?.status ?? undefined,
});

const desiredProperties = (news: HypervClusterProps) => ({
  fqdn: news.fqdn,
  runAsAccountId: news.runAsAccountId,
  hostFqdnList: news.hostFqdnList,
});

export const HypervClusterProvider = () =>
  Provider.succeed(HypervCluster, {
    stables: ["clusterName", "hypervSite", "resourceGroup", "clusterId"],

    // Inventory entries live inside their site; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.hypervSite.toLowerCase() !== output.hypervSite.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.clusterName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const site = output?.hypervSite ?? olds?.hypervSite;
      if (resourceGroup === undefined || site === undefined) return undefined;
      const name =
        output?.clusterName ?? olds?.name ?? (yield* migrateName(id));
      const observed = yield* getHypervCluster(
        subscriptionId,
        resourceGroup,
        site,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, site, name, observed);
      const parent = yield* getHypervSite(subscriptionId, resourceGroup, site);
      return (yield* ownedByStage(parent?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.OffAzure");
      const { resourceGroup, hypervSite } = news;
      const name = news.name ?? output?.clusterName ?? (yield* migrateName(id));
      const properties = desiredProperties(news);
      const get = getHypervCluster(
        subscriptionId,
        resourceGroup,
        hypervSite,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a create-or-update of the whole entry.
      if (
        observed === undefined ||
        settingsDiffer(properties, observed.properties)
      ) {
        yield* migrate.CreateHypervClusterControllerCluster({
          subscriptionId,
          resourceGroupName: resourceGroup,
          siteName: hypervSite,
          clusterName: name,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `Hyper-V cluster ${name}`,
        get,
        (entry) => entry.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, hypervSite, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        migrate.DeleteHypervClusterController({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          siteName: output.hypervSite,
          clusterName: output.clusterName,
        }),
      );
      yield* waitUntilGone(
        `Hyper-V cluster ${output.clusterName}`,
        getHypervCluster(
          subscriptionId,
          output.resourceGroup,
          output.hypervSite,
          output.clusterName,
        ),
      );
    }),
  });
