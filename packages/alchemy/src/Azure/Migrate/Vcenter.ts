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
import { getVmwareSite } from "./VmwareSite.ts";

export interface VcenterProps {
  /** Resource group of the VMware site. Changing it replaces the vCenter. */
  resourceGroup: string;
  /** VMware site the vCenter belongs to. Changing it replaces the vCenter. */
  vmwareSite: string;
  /**
   * Name of the vCenter in the site. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the vCenter.
   */
  name?: string;
  /** Fully qualified domain name (or IP address) of the vCenter. */
  fqdn: string;
  /**
   * ARM ID of the run-as account (credentials) the site's appliance uses to
   * connect. Run-as accounts are registered by the appliance; the service
   * rejects unknown IDs with `MigrateRunAsAccountInvalid`.
   */
  runAsAccountId: string;
  /**
   * Port the appliance connects to vCenter on.
   * @default "443"
   */
  port?: string;
  /** Display name of the vCenter in the portal. */
  friendlyName?: string;
}

export interface Vcenter extends Resource<
  "Azure.Migrate.Vcenter",
  VcenterProps,
  {
    /** Name of the vCenter in the site. */
    vcenterName: string;
    /** VMware site the vCenter belongs to. */
    vmwareSite: string;
    /** Resource group of the site. */
    resourceGroup: string;
    /** ARM resource ID of the vCenter. */
    vcenterId: string;
    /** Fully qualified domain name of the vCenter. */
    fqdn: string;
    /** Version the appliance reported, once it connected. */
    version: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Migrate vCenter (`Microsoft.OffAzure/vmwareSites/vcenters`) — a vCenter Server the site's appliance discovers VMware VMs from.
 *
 * The appliance registered with the site must be able to reach the
 * vCenter with the referenced run-as account; without a running appliance
 * Azure rejects the request. vCenter entries cannot be tagged; Alchemy
 * treats one as owned when its site carries this stack's and stage's
 * ownership tags.
 *
 * @see https://learn.microsoft.com/azure/migrate/migrate-appliance-architecture
 *
 * ### Adding a vCenter
 * **Example:** vCenter discovered by an appliance
 * ```typescript
 * const vcenter = yield* Azure.Migrate.Vcenter("vcenter", {
 *   resourceGroup: group.resourceGroupName,
 *   vmwareSite: site.siteName,
 *   fqdn: "vcenter.contoso.local",
 *   port: "443",
 *   runAsAccountId: "<run-as account ARM ID registered by the appliance>",
 * });
 * ```
 *
 * @resource
 */
export const Vcenter = Resource<Vcenter>("Azure.Migrate.Vcenter");

const getVcenter = (
  subscriptionId: string,
  resourceGroupName: string,
  siteName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    migrate
      .GetVcenterController({
        subscriptionId,
        resourceGroupName,
        siteName,
        vcenterName: name,
      })
      .pipe(
        // A missing vCenter is reported as "VCenter name '...' is invalid."
        Effect.catchTag("MigrateVcenterNotFound", () =>
          Effect.succeed(undefined),
        ),
      ),
  );

const toAttrs = (
  resourceGroup: string,
  site: string,
  name: string,
  observed: migrate.GetVcenterControllerResponse,
): Vcenter["Attributes"] => ({
  vcenterName: name,
  vmwareSite: site,
  resourceGroup,
  vcenterId: observed.id ?? "",
  fqdn: observed.properties?.fqdn ?? "",
  version: observed.properties?.version ?? undefined,
});

const desiredProperties = (news: VcenterProps) => ({
  fqdn: news.fqdn,
  runAsAccountId: news.runAsAccountId,
  port: news.port,
  friendlyName: news.friendlyName,
});

export const VcenterProvider = () =>
  Provider.succeed(Vcenter, {
    stables: ["vcenterName", "vmwareSite", "resourceGroup", "vcenterId"],

    // Inventory entries live inside their site; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.vmwareSite.toLowerCase() !== output.vmwareSite.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.vcenterName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const site = output?.vmwareSite ?? olds?.vmwareSite;
      if (resourceGroup === undefined || site === undefined) return undefined;
      const name =
        output?.vcenterName ?? olds?.name ?? (yield* migrateName(id));
      const observed = yield* getVcenter(
        subscriptionId,
        resourceGroup,
        site,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, site, name, observed);
      const parent = yield* getVmwareSite(subscriptionId, resourceGroup, site);
      return (yield* ownedByStage(parent?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.OffAzure");
      const { resourceGroup, vmwareSite } = news;
      const name = news.name ?? output?.vcenterName ?? (yield* migrateName(id));
      const properties = desiredProperties(news);
      const get = getVcenter(subscriptionId, resourceGroup, vmwareSite, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a create-or-update of the whole entry.
      if (
        observed === undefined ||
        settingsDiffer(properties, observed.properties)
      ) {
        yield* migrate.CreateVcenterController({
          subscriptionId,
          resourceGroupName: resourceGroup,
          siteName: vmwareSite,
          vcenterName: name,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `vCenter ${name}`,
        get,
        (entry) => entry.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, vmwareSite, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        migrate.DeleteVcenterController({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          siteName: output.vmwareSite,
          vcenterName: output.vcenterName,
        }),
      );
      yield* waitUntilGone(
        `vCenter ${output.vcenterName}`,
        getVcenter(
          subscriptionId,
          output.resourceGroup,
          output.vmwareSite,
          output.vcenterName,
        ),
      );
    }),
  });
