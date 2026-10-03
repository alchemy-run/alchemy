import * as resourceconnector from "@distilled.cloud/azure/resourceconnector";
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

/** On-premises fabric the Arc resource bridge runs on. */
export type ApplianceInfrastructureProvider = "VMWare" | "HCI" | "SCVMM";

export interface ApplianceProps {
  /**
   * Resource group the appliance is created in. Changing it replaces the
   * appliance.
   */
  resourceGroup: string;
  /**
   * Name of the appliance, 1-64 characters of letters, digits, `-`, `_`,
   * and `.`. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the appliance.
   */
  name?: string;
  /**
   * Azure location of the appliance. Changing it replaces the appliance.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * On-premises fabric hosting the appliance VM. Changing it replaces the
   * appliance.
   */
  infrastructureProvider: ApplianceInfrastructureProvider;
  /**
   * Kubernetes distribution the appliance runs. Changing it replaces the
   * appliance.
   * @default "AKSEdge"
   */
  distro?: "AKSEdge";
  /**
   * Public key of the certificate pair the appliance uses to download its
   * managed identity certificate. Azure accepts it only once; it is
   * usually written by the on-premises appliance VM during deployment.
   * Changing it replaces the appliance.
   */
  publicKey?: string;
  /**
   * Appliance version. Upgrades are driven from the on-premises side
   * (`az arcappliance upgrade`); this value is only sent on create.
   */
  version?: string;
  /**
   * Whether the appliance gets a system-assigned managed identity.
   * Changing it replaces the appliance.
   * @default true
   */
  systemAssignedIdentity?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Appliance extends Resource<
  "Azure.ResourceConnector.Appliance",
  ApplianceProps,
  {
    /** Name of the appliance. */
    applianceName: string;
    /** Resource group that holds the appliance. */
    resourceGroup: string;
    /** ARM resource ID of the appliance. */
    applianceId: string;
    /** Location of the appliance. */
    location: string;
    /** On-premises fabric hosting the appliance VM. */
    infrastructureProvider: string;
    /** Kubernetes distribution the appliance runs. */
    distro: string | undefined;
    /** Appliance version, once reported by the on-premises VM. */
    version: string | undefined;
    /**
     * Health of the connection to the on-premises appliance VM, e.g.
     * `WaitingForHeartbeat` until the VM is deployed, then `Running`.
     */
    status: string | undefined;
    /** ARM provisioning state. */
    provisioningState: string | undefined;
    /** Object ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc resource bridge (`Microsoft.ResourceConnector/appliances`)
 * — the Azure-side record of a Kubernetes management appliance running on
 * VMware vSphere, Azure Stack HCI, or System Center VMM. Creating the ARM
 * record reserves the bridge identity; it stays in `WaitingForHeartbeat`
 * until the on-premises appliance VM is deployed with
 * `az arcappliance deploy` and connects.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/resource-bridge/overview
 *
 * ### Creating an Appliance
 * **Example:** Resource bridge for Azure Stack HCI
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("arc");
 * const bridge = yield* Azure.ResourceConnector.Appliance("bridge", {
 *   resourceGroup: group.resourceGroupName,
 *   infrastructureProvider: "HCI",
 * });
 * ```
 *
 * **Example:** Resource bridge for VMware vSphere with tags
 * ```typescript
 * const bridge = yield* Azure.ResourceConnector.Appliance("vsphere", {
 *   resourceGroup: group.resourceGroupName,
 *   infrastructureProvider: "VMWare",
 *   tags: { site: "dc1" },
 * });
 * ```
 *
 * @resource
 */
export const Appliance = Resource<Appliance>(
  "Azure.ResourceConnector.Appliance",
);

type ObservedAppliance = resourceconnector.GetApplianceResponse;

const getAppliance = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) =>
  orUndefinedIfNotFound(
    resourceconnector.GetAppliance({
      subscriptionId,
      resourceGroupName,
      resourceName,
    }),
  );

const makeName = (id: string) =>
  createPhysicalName({ id, maxLength: 64, delimiter: "-" });

const toAttrs = (
  resourceGroup: string,
  name: string,
  appliance: ObservedAppliance,
): Appliance["Attributes"] => ({
  applianceName: name,
  resourceGroup,
  applianceId: appliance.id ?? "",
  location: appliance.location,
  infrastructureProvider:
    appliance.properties?.infrastructureConfig?.provider ?? "",
  distro: appliance.properties?.distro,
  version: appliance.properties?.version,
  status: appliance.properties?.status,
  provisioningState: appliance.properties?.provisioningState,
  principalId: appliance.identity?.principalId,
  tags: userTags(appliance.tags),
});

const eq = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

export const ApplianceProvider = () =>
  Provider.succeed(Appliance, {
    stables: [
      "applianceName",
      "resourceGroup",
      "applianceId",
      "location",
      "infrastructureProvider",
      "distro",
      "principalId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* resourceconnector
        .ListApplianceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListApplianceBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((appliance) => {
        const group = resourceGroupOf(appliance.id);
        return hasAnyAlchemyTag(appliance.tags) &&
          group !== undefined &&
          appliance.name !== undefined
          ? [toAttrs(group, appliance.name, appliance)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !eq(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !eq(news.name, output.applianceName)) ||
        (news.location !== undefined && !eq(news.location, output.location)) ||
        !eq(news.infrastructureProvider, output.infrastructureProvider) ||
        (news.distro !== undefined &&
          output.distro !== undefined &&
          !eq(news.distro, output.distro)) ||
        (news.systemAssignedIdentity ?? true) !==
          (olds?.systemAssignedIdentity ?? true) ||
        (olds !== undefined && news.publicKey !== olds.publicKey)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.applianceName ?? olds?.name ?? (yield* makeName(id));
      const observed = yield* getAppliance(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ResourceConnector");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.applianceName ?? (yield* makeName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: name,
      };
      const get = getAppliance(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure: PUT is an async LRO (201 + Azure-AsyncOperation).
      if (observed === undefined) {
        yield* resourceconnector.AppliancesCreateOrUpdate({
          ...request,
          location,
          tags,
          properties: {
            distro: news.distro ?? "AKSEdge",
            infrastructureConfig: { provider: news.infrastructureProvider },
            publicKey: news.publicKey,
            version: news.version,
          },
          identity: {
            type:
              (news.systemAssignedIdentity ?? true) ? "SystemAssigned" : "None",
          },
        });
      }
      observed = yield* waitForProvisioned(
        `appliance ${name}`,
        get,
        (a) => a.properties?.provisioningState,
      );

      // Sync tags (the only property PATCH accepts).
      if (tagsDiffer(observed.tags, tags)) {
        yield* resourceconnector.UpdateAppliance({ ...request, tags });
        observed = yield* waitForProvisioned(
          `appliance ${name}`,
          get,
          (a) => a.properties?.provisioningState,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        resourceconnector.DeleteAppliance({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.applianceName,
        }),
      );
      yield* waitUntilGone(
        `appliance ${output.applianceName}`,
        getAppliance(
          subscriptionId,
          output.resourceGroup,
          output.applianceName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
