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

export interface HypervHostProps {
  /** Resource group of the Hyper-V site. Changing it replaces the Hyper-V host. */
  resourceGroup: string;
  /** Hyper-V site the Hyper-V host belongs to. Changing it replaces the Hyper-V host. */
  hypervSite: string;
  /**
   * Name of the Hyper-V host in the site. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the Hyper-V host.
   */
  name?: string;
  /** Fully qualified domain name (or IP address) of the Hyper-V host. */
  fqdn: string;
  /**
   * ARM ID of the run-as account (credentials) the site's appliance uses to
   * connect. Run-as accounts are registered by the appliance; the service
   * rejects unknown IDs with `MigrateRunAsAccountInvalid`.
   */
  runAsAccountId: string;
}

export interface HypervHost extends Resource<
  "Azure.Migrate.HypervHost",
  HypervHostProps,
  {
    /** Name of the Hyper-V host in the site. */
    hostName: string;
    /** Hyper-V site the Hyper-V host belongs to. */
    hypervSite: string;
    /** Resource group of the site. */
    resourceGroup: string;
    /** ARM resource ID of the Hyper-V host. */
    hostId: string;
    /** Fully qualified domain name of the Hyper-V host. */
    fqdn: string;
    /** Version the appliance reported, once it connected. */
    version: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Migrate Hyper-V host (`Microsoft.OffAzure/hypervSites/hosts`) — a standalone Hyper-V host the site's appliance discovers VMs from.
 *
 * The appliance registered with the site must be able to reach the
 * Hyper-V host with the referenced run-as account; without a running appliance
 * Azure rejects the request. Hyper-V host entries cannot be tagged; Alchemy
 * treats one as owned when its site carries this stack's and stage's
 * ownership tags.
 *
 * @see https://learn.microsoft.com/azure/migrate/migrate-appliance-architecture
 *
 * ### Adding a Hyper-V host
 * **Example:** Hyper-V host discovered by an appliance
 * ```typescript
 * const host = yield* Azure.Migrate.HypervHost("host", {
 *   resourceGroup: group.resourceGroupName,
 *   hypervSite: site.siteName,
 *   fqdn: "hyperv01.contoso.local",
 *   runAsAccountId: "<run-as account ARM ID registered by the appliance>",
 * });
 * ```
 *
 * @resource
 */
export const HypervHost = Resource<HypervHost>("Azure.Migrate.HypervHost");

const getHypervHost = (
  subscriptionId: string,
  resourceGroupName: string,
  siteName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    migrate.GetHypervHostController({
      subscriptionId,
      resourceGroupName,
      siteName,
      hostName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  site: string,
  name: string,
  observed: migrate.GetHypervHostControllerResponse,
): HypervHost["Attributes"] => ({
  hostName: name,
  hypervSite: site,
  resourceGroup,
  hostId: observed.id ?? "",
  fqdn: observed.properties?.fqdn ?? "",
  version: observed.properties?.version ?? undefined,
});

const desiredProperties = (news: HypervHostProps) => ({
  fqdn: news.fqdn,
  runAsAccountId: news.runAsAccountId,
});

export const HypervHostProvider = () =>
  Provider.succeed(HypervHost, {
    stables: ["hostName", "hypervSite", "resourceGroup", "hostId"],

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
          news.name.toLowerCase() !== output.hostName.toLowerCase())
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
      const name = output?.hostName ?? olds?.name ?? (yield* migrateName(id));
      const observed = yield* getHypervHost(
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
      const name = news.name ?? output?.hostName ?? (yield* migrateName(id));
      const properties = desiredProperties(news);
      const get = getHypervHost(
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
        yield* migrate.CreateHypervHostController({
          subscriptionId,
          resourceGroupName: resourceGroup,
          siteName: hypervSite,
          hostName: name,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `Hyper-V host ${name}`,
        get,
        (entry) => entry.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, hypervSite, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        migrate.DeleteHypervHostController({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          siteName: output.hypervSite,
          hostName: output.hostName,
        }),
      );
      yield* waitUntilGone(
        `Hyper-V host ${output.hostName}`,
        getHypervHost(
          subscriptionId,
          output.resourceGroup,
          output.hypervSite,
          output.hostName,
        ),
      );
    }),
  });
