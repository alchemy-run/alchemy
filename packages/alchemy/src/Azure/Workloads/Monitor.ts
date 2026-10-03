import * as workloads from "@distilled.cloud/azure/workloads";
import * as Effect from "effect/Effect";
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
  getMonitor,
  identityBlock,
  identityIds,
  lower,
  withRecordedError,
} from "./Common.ts";

export interface MonitorProps {
  /**
   * Resource group the monitor is created in. Changing it replaces the
   * monitor.
   */
  resourceGroup: string;
  /**
   * Monitor name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the monitor.
   */
  name?: string;
  /**
   * Azure location of the monitor resource. Changing it replaces the
   * monitor.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Region the monitoring infrastructure (function app, storage account,
   * key vault) is deployed to. Must match the region of `monitorSubnet`.
   * Changing it replaces the monitor.
   * @default the monitor's `location`
   */
  appLocation?: string;
  /**
   * ARM ID of the subnet the monitor's function app joins. The subnet must
   * be delegated to `Microsoft.Web/serverFarms` and have outbound
   * connectivity to the monitored SAP systems. Changing it replaces the
   * monitor.
   */
  monitorSubnet: string;
  /**
   * Routing preference: `Default` routes only RFC 1918 traffic through the
   * virtual network, `RouteAll` routes all traffic. Changing it replaces
   * the monitor.
   * @default "Default"
   */
  routingPreference?: "Default" | "RouteAll";
  /**
   * Zone-redundancy preference for the managed resources. Changing it
   * replaces the monitor.
   * @default Azure's default (no zone redundancy)
   */
  zoneRedundancyPreference?: string;
  /**
   * Name of the managed resource group Azure creates for the monitoring
   * infrastructure. Changing it replaces the monitor.
   * @default `mrg-{monitor name}`
   */
  managedResourceGroupName?: string;
  /**
   * ARM ID of an existing Log Analytics workspace to send monitoring data
   * to. Changing it replaces the monitor.
   * @default a workspace created in the managed resource group
   */
  logAnalyticsWorkspaceArmId?: string;
  /**
   * ARM IDs of pre-created user-assigned identities for the monitor.
   * @default no identity
   */
  userAssignedIdentityIds?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Monitor extends Resource<
  "Azure.Workloads.Monitor",
  MonitorProps,
  {
    /** Name of the monitor. */
    monitorName: string;
    /** ARM resource ID of the monitor. */
    monitorId: string;
    /** Resource group that holds the monitor. */
    resourceGroup: string;
    /** Location of the monitor resource. */
    location: string;
    /** Region of the monitoring infrastructure. */
    appLocation: string | undefined;
    /** ARM ID of the subnet the monitor is deployed in. */
    monitorSubnet: string | undefined;
    /** Routing preference of the monitor. */
    routingPreference: string | undefined;
    /** Zone-redundancy preference of the managed resources. */
    zoneRedundancyPreference: string | undefined;
    /** Name of the managed resource group holding the monitoring infrastructure. */
    managedResourceGroupName: string | undefined;
    /** ARM ID of the Log Analytics workspace that receives monitoring data. */
    logAnalyticsWorkspaceArmId: string | undefined;
    /** ARM ID of the managed identity the monitor uses. */
    msiArmId: string | undefined;
    /** ARM ID of the storage account the monitor uses. */
    storageAccountArmId: string | undefined;
    /** ARM IDs of the user-assigned identities on the monitor. */
    userAssignedIdentityIds: string[];
    /** Provisioning state of the monitor. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Monitor for SAP solutions (AMS) monitor. It deploys a function
 * app, storage account, key vault, and (optionally) Log Analytics workspace
 * into a managed resource group and collects telemetry from SAP systems
 * reachable from its subnet. Add {@link ProviderInstance}s to point it at
 * SAP HANA, NetWeaver, SQL Server, Db2, or Prometheus endpoints.
 *
 * Creating a monitor takes 10–20 minutes and bills the managed
 * infrastructure while it exists.
 *
 * @see https://learn.microsoft.com/azure/sap/monitor/about-azure-monitor-sap-solutions
 *
 * ### Creating a Monitor
 * **Example:** Monitor in a delegated subnet
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("sap", {});
 * const vnet = yield* Azure.Network.VirtualNetwork("sap-vnet", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("ams", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   delegations: [{ serviceName: "Microsoft.Web/serverFarms" }],
 * });
 * const monitor = yield* Azure.Workloads.Monitor("ams", {
 *   resourceGroup: group.resourceGroupName,
 *   monitorSubnet: subnet.subnetId,
 * });
 * ```
 *
 * **Example:** Monitor that routes all traffic through the VNet
 * ```typescript
 * const monitor = yield* Azure.Workloads.Monitor("ams", {
 *   resourceGroup: group.resourceGroupName,
 *   monitorSubnet: subnet.subnetId,
 *   routingPreference: "RouteAll",
 *   tags: { team: "sap-basis" },
 * });
 * ```
 *
 * ### Bring Your Own Log Analytics Workspace
 * **Example:** Send data to an existing workspace
 * ```typescript
 * const monitor = yield* Azure.Workloads.Monitor("ams", {
 *   resourceGroup: group.resourceGroupName,
 *   monitorSubnet: subnet.subnetId,
 *   logAnalyticsWorkspaceArmId: workspace.workspaceId,
 * });
 * ```
 *
 * @resource
 */
export const Monitor = Resource<Monitor>("Azure.Workloads.Monitor");

type ObservedMonitor = workloads.GetMonitorResponse;

const createMonitorName = (id: string) =>
  createPhysicalName({ id, maxLength: 60 });

const toAttrs = (
  resourceGroup: string,
  name: string,
  monitor: ObservedMonitor,
): Monitor["Attributes"] => {
  const props = monitor.properties;
  return {
    monitorName: name,
    monitorId: monitor.id ?? "",
    resourceGroup,
    location: monitor.location,
    appLocation: props?.appLocation,
    monitorSubnet: props?.monitorSubnet,
    routingPreference: props?.routingPreference,
    zoneRedundancyPreference: props?.zoneRedundancyPreference,
    managedResourceGroupName: props?.managedResourceGroupConfiguration?.name,
    logAnalyticsWorkspaceArmId: props?.logAnalyticsWorkspaceArmId,
    msiArmId: props?.msiArmId,
    storageAccountArmId: props?.storageAccountArmId,
    userAssignedIdentityIds: Object.keys(
      monitor.identity?.userAssignedIdentities ?? {},
    ),
    provisioningState: props?.provisioningState,
    tags: userTags(monitor.tags),
  };
};

const describeErrors = (monitor: ObservedMonitor | undefined) => {
  const errors = monitor?.properties?.errors;
  if (errors === undefined) return undefined;
  const details = (errors.details ?? [])
    .map((d) => `${d.code ?? ""} ${d.message ?? ""}`.trim())
    .join("; ");
  return [errors.code, errors.message, details].filter(Boolean).join(": ");
};

/** Differs when `desired` is set and does not match `observed`. */
const changed = (desired: string | undefined, observed: string | undefined) =>
  desired !== undefined && lower(desired) !== lower(observed);

export const MonitorProvider = () =>
  Provider.succeed(Monitor, {
    stables: ["monitorName", "monitorId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* workloads
        .ListMonitors({ subscriptionId })
        .pipe(Effect.flatMap((page) => requireSinglePage("ListMonitors", page)));
      return (page.value ?? []).flatMap((monitor) => {
        const group = resourceGroupOf(monitor.id);
        return hasAnyAlchemyTag(monitor.tags) &&
          group !== undefined &&
          monitor.name !== undefined
          ? [toAttrs(group, monitor.name, monitor)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.monitorName) ||
        changed(news.location, output.location) ||
        changed(news.appLocation, output.appLocation) ||
        changed(news.monitorSubnet, output.monitorSubnet) ||
        changed(news.routingPreference ?? "Default", output.routingPreference) ||
        changed(news.zoneRedundancyPreference, output.zoneRedundancyPreference) ||
        changed(news.managedResourceGroupName, output.managedResourceGroupName) ||
        changed(
          news.logAnalyticsWorkspaceArmId,
          output.logAnalyticsWorkspaceArmId,
        )
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
        output?.monitorName ?? olds?.name ?? (yield* createMonitorName(id));
      const observed = yield* getMonitor(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Workloads");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.monitorName ?? (yield* createMonitorName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = identityBlock(news.userAssignedIdentityIds);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        monitorName: name,
      };
      const label = `SAP monitor ${name}`;
      const get = getMonitor(subscriptionId, resourceGroup, name);
      // Provisioning deploys a function app and its dependencies into the
      // managed resource group: allow up to 20 minutes.
      const waitReady = waitForProvisioned(
        label,
        get,
        (monitor) => monitor.properties?.provisioningState,
        { interval: "20 seconds", times: 60 },
      ).pipe(withRecordedError(Effect.map(get, describeErrors)));

      // Observe.
      let observed = yield* get;

      // Ensure. A monitor whose creation failed is re-submitted.
      if (
        observed === undefined ||
        observed.properties?.provisioningState === "Failed"
      ) {
        yield* workloads.CreateMonitor({
          ...where,
          location,
          tags,
          identity: news.userAssignedIdentityIds?.length ? identity : undefined,
          properties: {
            appLocation: news.appLocation ?? location,
            monitorSubnet: news.monitorSubnet,
            routingPreference: news.routingPreference ?? "Default",
            zoneRedundancyPreference: news.zoneRedundancyPreference,
            managedResourceGroupConfiguration: {
              name: news.managedResourceGroupName ?? `mrg-${name}`.slice(0, 90),
            },
            logAnalyticsWorkspaceArmId: news.logAnalyticsWorkspaceArmId,
          },
        });
      }
      observed = yield* waitReady;

      // Sync tags and identity (the only PATCHable aspects).
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged =
        identityIds(Object.keys(observed.identity?.userAssignedIdentities ?? {}))
          .join(",") !== identityIds(news.userAssignedIdentityIds).join(",");
      if (tagsChanged || identityChanged) {
        yield* workloads.UpdateMonitor({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? identity : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        workloads.DeleteMonitor({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          monitorName: output.monitorName,
        }),
      );
      // Deleting the monitor also tears down its managed resource group.
      yield* waitUntilGone(
        `SAP monitor ${output.monitorName}`,
        getMonitor(subscriptionId, output.resourceGroup, output.monitorName),
        { interval: "15 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
