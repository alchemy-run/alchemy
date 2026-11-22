import * as compute from "@distilled.cloud/azure/compute";
import * as serialconsole from "@distilled.cloud/azure/serialconsole";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

/** The parent resource type a serial port belongs to. */
export type SerialPortParentType = "virtualMachines" | "virtualMachineScaleSets";

export interface SerialPortProps {
  /**
   * Resource group of the parent VM or scale set. Changing it replaces the
   * serial port.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the parent VM (or VM scale set when `parentType` is
   * `virtualMachineScaleSets`). Changing it replaces the serial port.
   */
  virtualMachine: string;
  /**
   * Resource type of the parent (under `Microsoft.Compute`). Changing it
   * replaces the serial port.
   * @default "virtualMachines"
   */
  parentType?: SerialPortParentType;
  /**
   * Serial port name. Azure exposes only port `0`; other names are rejected
   * with `InvalidParameter`. Changing it replaces the serial port.
   * @default "0"
   */
  name?: string;
  /**
   * Whether the port accepts serial console connections.
   * @default "enabled"
   */
  state?: serialconsole.SerialPortState;
}

export interface SerialPort extends Resource<
  "Azure.SerialConsole.SerialPort",
  SerialPortProps,
  {
    /** ARM resource ID of the serial port. */
    serialPortId: string;
    /** Serial port name, e.g. `0`. */
    serialPortName: string;
    /** Resource group of the parent VM or scale set. */
    resourceGroup: string;
    /** Name of the parent VM or scale set. */
    virtualMachine: string;
    /** Resource type of the parent. */
    parentType: SerialPortParentType;
    /** Observed port state (`enabled` or `disabled`). */
    state: string;
    /** Whether a console session is currently attached (`active`/`inactive`). */
    connectionState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The serial console port of an Azure VM or VM scale set
 * (`Microsoft.SerialConsole/serialPorts`). Use it to turn the Azure Serial
 * Console on or off for one machine. See the
 * [Azure docs](https://learn.microsoft.com/troubleshoot/azure/virtual-machines/windows/serial-console-overview).
 *
 * Port `0` exists on every VM and is enabled by default, so this resource
 * configures it rather than creating it. Destroying the resource resets the
 * port to `enabled`. The port carries no tags. Ownership follows the parent
 * VM, which must carry the same Alchemy stack and stage tags.
 *
 * :::caution
 * A console session only connects when the parent has boot diagnostics
 * enabled.
 * :::
 *
 * :::caution
 * Changing `resourceGroup`, `virtualMachine`, `parentType`, or `name`
 * replaces the serial port. Alchemy updates `state` in place.
 * :::
 *
 * ### Enabling the Serial Console
 * **Example:** Serial port on a VM
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("vms", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 * });
 * const nic = yield* Azure.Network.NetworkInterface("vm", {
 *   ipConfigurations: [{ subnetId: subnet.subnetId }],
 * });
 * const vm = yield* Azure.Compute.VirtualMachine("Vm", {
 *   vmSize: "Standard_B1s",
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: ["ssh-ed25519 AAAAC3Nza... me@example.com"],
 *   bootDiagnostics: true,
 * });
 * yield* Azure.SerialConsole.SerialPort("Console", {
 *   virtualMachine: vm.virtualMachineName,
 * });
 * ```
 *
 * ### Disabling the Serial Console
 * **Example:** Block console sessions to a VM
 * ```typescript
 * yield* Azure.SerialConsole.SerialPort("Console", {
 *   virtualMachine: "web-vm",
 *   state: "disabled",
 * });
 * ```
 *
 * @resource
 */
export const SerialPort = GroupedResource<SerialPort>("Azure.SerialConsole.SerialPort");

const NAMESPACE = "Microsoft.Compute";

type Observed = serialconsole.GetSerialPortResponse;

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const getPort = (
  subscriptionId: string,
  resourceGroup: string,
  parentType: SerialPortParentType,
  parent: string,
  serialPort: string,
) =>
  orUndefinedIfNotFound(
    serialconsole.GetSerialPort({
      subscriptionId,
      resourceGroupName: resourceGroup,
      resourceProviderNamespace: NAMESPACE,
      parentResourceType: parentType,
      parentResource: parent,
      serialPort,
    }),
  );

/** Tags of the parent VM / scale set, or `undefined` when it is gone. */
const parentTags = (
  subscriptionId: string,
  resourceGroup: string,
  parentType: SerialPortParentType,
  parent: string,
) =>
  parentType === "virtualMachineScaleSets"
    ? orUndefinedIfNotFound(
        compute.GetVirtualMachineScaleSet({
          subscriptionId,
          resourceGroupName: resourceGroup,
          vmScaleSetName: parent,
        }),
      ).pipe(Effect.map((p) => p?.tags))
    : orUndefinedIfNotFound(
        compute.GetVirtualMachine({
          subscriptionId,
          resourceGroupName: resourceGroup,
          vmName: parent,
        }),
      ).pipe(Effect.map((p) => p?.tags));

const toAttrs = (
  resourceGroup: string,
  parentType: SerialPortParentType,
  parent: string,
  name: string,
  observed: Observed,
): SerialPort["Attributes"] => ({
  serialPortId: observed.id ?? "",
  serialPortName: name,
  resourceGroup,
  virtualMachine: parent,
  parentType,
  state: observed.properties?.state ?? "enabled",
  connectionState: observed.properties?.connectionState,
});

export const SerialPortProvider = () =>
  Provider.succeed(SerialPort, {
    stables: ["serialPortId", "serialPortName", "resourceGroup", "virtualMachine", "parentType"],

    // Serial ports carry no tags and disappear with their VM.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.virtualMachine, output.virtualMachine) ||
        (news.parentType ?? "virtualMachines") !== output.parentType ||
        (news.name ?? "0") !== output.serialPortName
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const parent = output?.virtualMachine ?? olds?.virtualMachine;
      if (resourceGroup === undefined || parent === undefined) return undefined;
      const parentType = output?.parentType ?? olds?.parentType ?? "virtualMachines";
      const name = output?.serialPortName ?? olds?.name ?? "0";
      const observed = yield* getPort(subscriptionId, resourceGroup, parentType, parent, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, parentType, parent, name, observed);
      const tags = yield* parentTags(subscriptionId, resourceGroup, parentType, parent);
      const { stack, stage } = yield* stackAndStage;
      return tags?.["alchemy::stack"] === stack && tags?.["alchemy::stage"] === stage
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.SerialConsole");
      const resourceGroup = news.resourceGroup;
      const parent = news.virtualMachine;
      const parentType = news.parentType ?? "virtualMachines";
      const name = news.name ?? "0";
      const state = news.state ?? "enabled";

      // Observe.
      const observed = yield* getPort(subscriptionId, resourceGroup, parentType, parent, name);

      // Ensure + sync: PUT only when missing or the state drifted. The PUT
      // response swaps `id` and `name`, so re-read instead of trusting it.
      if (observed === undefined || observed.properties?.state !== state) {
        yield* serialconsole.CreateSerialPort({
          subscriptionId,
          resourceGroupName: resourceGroup,
          resourceProviderNamespace: NAMESPACE,
          parentResourceType: parentType,
          parentResource: parent,
          serialPort: name,
          properties: { state },
        });
      }
      const fresh = yield* serialconsole.GetSerialPort({
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceProviderNamespace: NAMESPACE,
        parentResourceType: parentType,
        parentResource: parent,
        serialPort: name,
      });
      return toAttrs(resourceGroup, parentType, parent, name, fresh);
    }),

    // Port 0 exists implicitly on every VM: DELETE resets it to the
    // default (`enabled`) instead of removing it, synchronously.
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        serialconsole.DeleteSerialPort({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceProviderNamespace: NAMESPACE,
          parentResourceType: output.parentType,
          parentResource: output.virtualMachine,
          serialPort: output.serialPortName,
        }),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Compute.VirtualMachine",
        "Azure.Compute.VirtualMachineScaleSet",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
