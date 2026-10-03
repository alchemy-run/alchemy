import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
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

export type MachineKind = hybridcompute.ArcKindEnum;

export interface MachineLocationData {
  /** Canonical name of the geographic or physical location. */
  name: string;
  /** City or locality. */
  city?: string;
  /** District, state, or province. */
  district?: string;
  /** Country or region. */
  countryOrRegion?: string;
}

export interface MachineProps {
  /**
   * Resource group the machine is registered in. Changing it replaces the
   * machine.
   */
  resourceGroup: string;
  /**
   * Name of the machine. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the machine.
   */
  name?: string;
  /**
   * Azure location the machine's metadata lives in. Changing it replaces
   * the machine.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Kind of on-premises placement (`AVS`, `HCI`, `SCVMM`, `VMware`, `EPS`,
   * `GCP`, `AWS`). Changing it replaces the machine.
   */
  kind?: MachineKind;
  /**
   * Unique ID of the host. Required to pre-register a machine before the
   * Connected Machine agent runs `azcmagent connect`. Changing it replaces
   * the machine.
   */
  vmId?: string;
  /**
   * Base64 public key the agent uses during onboarding. Required together
   * with `vmId` to pre-register a machine. Changing it replaces the
   * machine.
   */
  clientPublicKey?: string;
  /**
   * Operating system type (`windows` or `linux`). Changing it replaces the
   * machine.
   */
  osType?: "windows" | "linux";
  /**
   * ARM ID of the `HybridCompute.PrivateLinkScope` the machine reaches
   * Azure Arc through.
   */
  privateLinkScopeResourceId?: string;
  /** Geographic or physical location of the host. */
  locationData?: MachineLocationData;
  /**
   * Whether Azure upgrades the Connected Machine agent automatically.
   * @default false
   */
  enableAutomaticUpgrade?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Machine extends Resource<
  "Azure.HybridCompute.Machine",
  MachineProps,
  {
    /** Name of the machine. */
    machineName: string;
    /** Resource group that holds the machine. */
    resourceGroup: string;
    /** ARM resource ID of the machine. */
    machineId: string;
    /** Location of the machine's metadata. */
    location: string;
    /** Placement kind, if any. */
    kind: string | undefined;
    /**
     * Connection status (`AwaitingConnection`, `Connected`,
     * `Disconnected`, `Expired`).
     */
    status: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** Unique ID of the host. */
    vmId: string | undefined;
    /** Object ID of the machine's system-assigned identity. */
    principalId: string | undefined;
    /** Fully qualified domain name reported by the agent. */
    machineFqdn: string | undefined;
    /** Operating system name reported by the agent. */
    osName: string | undefined;
    /** Operating system type. */
    osType: string | undefined;
    /** Connected Machine agent version. */
    agentVersion: string | undefined;
    /** Private link scope the machine is assigned to. */
    privateLinkScopeResourceId: string | undefined;
    /** Whether automatic agent upgrade is enabled. */
    enableAutomaticUpgrade: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc-enabled server — the ARM projection of a machine that runs
 * outside Azure (on-premises or another cloud) with the Connected Machine
 * agent.
 *
 * Machines are normally registered by `azcmagent connect`. Declaring one
 * with `vmId` and `clientPublicKey` pre-registers it: the record waits in
 * `AwaitingConnection` until the agent on that host connects, and it can
 * be tagged, scoped to a private link scope, and associated with a gateway
 * beforehand.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/servers/overview
 *
 * ### Registering a Machine
 * **Example:** Pre-register a Linux server
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("arc");
 * const machine = yield* Azure.HybridCompute.Machine("web-01", {
 *   resourceGroup: group.resourceGroupName,
 *   vmId: "3f2c1a9e-5b7d-4e8a-9c21-7d6e5f4a3b2c",
 *   clientPublicKey: agentPublicKey,
 *   osType: "linux",
 * });
 * ```
 *
 * ### Private Connectivity
 * **Example:** Assign the machine to a private link scope
 * ```typescript
 * const scope = yield* Azure.HybridCompute.PrivateLinkScope("arc-scope", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const machine = yield* Azure.HybridCompute.Machine("web-01", {
 *   resourceGroup: group.resourceGroupName,
 *   vmId,
 *   clientPublicKey: agentPublicKey,
 *   privateLinkScopeResourceId: scope.privateLinkScopeResourceId,
 * });
 * ```
 *
 * @resource
 */
export const Machine = Resource<Machine>("Azure.HybridCompute.Machine");

type ObservedMachine = hybridcompute.GetMachineResponse | hybridcompute.Machine;

export const getMachine = (
  subscriptionId: string,
  resourceGroupName: string,
  machineName: string,
) =>
  orUndefinedIfNotFound(
    hybridcompute.GetMachine({
      subscriptionId,
      resourceGroupName,
      machineName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  machine: ObservedMachine,
): Machine["Attributes"] => ({
  machineName: name,
  resourceGroup,
  machineId: machine.id ?? "",
  location: machine.location,
  kind: machine.kind,
  status: machine.properties?.status,
  provisioningState: machine.properties?.provisioningState,
  vmId: machine.properties?.vmId,
  principalId: machine.identity?.principalId,
  machineFqdn: machine.properties?.machineFqdn,
  osName: machine.properties?.osName,
  osType: machine.properties?.osType,
  agentVersion: machine.properties?.agentVersion,
  privateLinkScopeResourceId: machine.properties?.privateLinkScopeResourceId,
  enableAutomaticUpgrade:
    machine.properties?.agentUpgrade?.enableAutomaticUpgrade ?? false,
  tags: userTags(machine.tags),
});

const nameOf = (id: string) => createPhysicalName({ id, maxLength: 54 });

const differs = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() !== (b ?? "").toLowerCase();

const sameLocationData = (
  observed: MachineLocationData | undefined,
  desired: MachineLocationData | undefined,
) =>
  desired === undefined ||
  (observed !== undefined &&
    observed.name === desired.name &&
    (observed.city ?? "") === (desired.city ?? "") &&
    (observed.district ?? "") === (desired.district ?? "") &&
    (observed.countryOrRegion ?? "") === (desired.countryOrRegion ?? ""));

/**
 * A machine waiting for its agent stays `Creating` until the agent
 * connects; it is usable (taggable, configurable) as soon as it is
 * readable.
 */
const machineState = (machine: ObservedMachine) =>
  machine.properties?.status === "AwaitingConnection"
    ? undefined
    : machine.properties?.provisioningState;

export const MachineProvider = () =>
  Provider.succeed(Machine, {
    stables: [
      "machineName",
      "resourceGroup",
      "machineId",
      "location",
      "kind",
      "vmId",
      "principalId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* hybridcompute
        .ListMachineBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListMachineBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((machine) => {
        const group = resourceGroupOf(machine.id);
        return hasAnyAlchemyTag(machine.tags) &&
          group !== undefined &&
          machine.name !== undefined
          ? [toAttrs(group, machine.name, machine)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        differs(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && differs(news.name, output.machineName)) ||
        (news.location !== undefined &&
          differs(news.location, output.location)) ||
        (news.kind !== undefined && differs(news.kind, output.kind)) ||
        (news.vmId !== undefined && differs(news.vmId, output.vmId)) ||
        (news.osType !== undefined && differs(news.osType, output.osType)) ||
        (olds !== undefined && news.clientPublicKey !== olds.clientPublicKey)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.machineName ?? olds?.name ?? (yield* nameOf(id));
      const observed = yield* getMachine(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.HybridCompute");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.machineName ?? (yield* nameOf(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const enableAutomaticUpgrade = news.enableAutomaticUpgrade ?? false;
      const label = `arc machine ${name}`;
      const get = getMachine(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure: register the machine when missing.
      if (observed === undefined) {
        yield* hybridcompute.MachinesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          machineName: name,
          location,
          tags,
          identity: { type: "SystemAssigned" },
          ...(news.kind !== undefined ? { kind: news.kind } : {}),
          properties: {
            vmId: news.vmId,
            clientPublicKey: news.clientPublicKey,
            osType: news.osType,
            privateLinkScopeResourceId: news.privateLinkScopeResourceId,
            locationData: news.locationData,
            agentUpgrade: { enableAutomaticUpgrade },
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, machineState);

      // Sync mutable aspects against observed state; PATCH only deltas.
      const props = observed.properties;
      const scopeChanged =
        news.privateLinkScopeResourceId !== undefined &&
        differs(
          props?.privateLinkScopeResourceId,
          news.privateLinkScopeResourceId,
        );
      const locationChanged = !sameLocationData(
        props?.locationData,
        news.locationData,
      );
      const upgradeChanged =
        (props?.agentUpgrade?.enableAutomaticUpgrade ?? false) !==
        enableAutomaticUpgrade;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (scopeChanged || locationChanged || upgradeChanged || tagsChanged) {
        yield* hybridcompute.UpdateMachine({
          subscriptionId,
          resourceGroupName: resourceGroup,
          machineName: name,
          ...(tagsChanged ? { tags } : {}),
          ...(scopeChanged || locationChanged || upgradeChanged
            ? {
                properties: {
                  ...(scopeChanged
                    ? {
                        privateLinkScopeResourceId:
                          news.privateLinkScopeResourceId,
                      }
                    : {}),
                  ...(locationChanged
                    ? { locationData: news.locationData }
                    : {}),
                  ...(upgradeChanged
                    ? { agentUpgrade: { enableAutomaticUpgrade } }
                    : {}),
                },
              }
            : {}),
        });
        observed = yield* waitForProvisioned(label, get, machineState);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridcompute.DeleteMachine({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          machineName: output.machineName,
        }),
      );
      yield* waitUntilGone(
        `arc machine ${output.machineName}`,
        getMachine(subscriptionId, output.resourceGroup, output.machineName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
