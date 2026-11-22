import * as compute from "@distilled.cloud/azure/compute";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createComputeName,
  runCommandDrifted,
  runCommandInput,
  runCommandResult,
  sameId,
  scaleSetLocation,
  waitComputeGone,
  waitRunCommandFinished,
  whileComputeBusy,
  type RunCommandSourceProps,
} from "./common.ts";

export interface VirtualMachineScaleSetVMRunCommandProps extends RunCommandSourceProps {
  /**
   * Resource group of the scale set. Changing it replaces the run command.
   */
  resourceGroup: string;
  /**
   * Name of the `Uniform` scale set. Changing it replaces the run command.
   */
  virtualMachineScaleSet: string;
  /**
   * Instance ID of the scale set VM the command runs on, e.g. `"0"` (see
   * the scale set's `instanceIds`). Changing it replaces the run command.
   */
  instanceId: string;
  /**
   * Name of the run command. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the run command.
   */
  name?: string;
  /**
   * Location of the scale set. Changing it replaces the run command.
   * @default the scale set's location
   */
  location?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically. Changing them replaces the
   * run command (and runs it again).
   */
  tags?: Record<string, string>;
}

export interface VirtualMachineScaleSetVMRunCommand extends Resource<
  "Azure.Compute.VirtualMachineScaleSetVMRunCommand",
  VirtualMachineScaleSetVMRunCommandProps,
  {
    /** Name of the run command. */
    runCommandName: string;
    /** ARM resource ID of the run command. */
    runCommandId: string;
    /** Name of the scale set. */
    virtualMachineScaleSet: string;
    /** Instance ID of the scale set VM. */
    instanceId: string;
    /** Resource group of the scale set. */
    resourceGroup: string;
    /** Location of the run command. */
    location: string;
    /** Provisioning state (`Succeeded` once the script ran). */
    provisioningState: string | undefined;
    /** Execution state, e.g. `Succeeded`, `Failed`, `Running`. */
    executionState: string | undefined;
    /** Exit code of the script. */
    exitCode: number | undefined;
    /** Standard output of the script (truncated by Azure to 4 KiB). */
    output: string | undefined;
    /** Standard error of the script (truncated by Azure to 4 KiB). */
    error: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A managed run command on one VM of a `Uniform` Azure virtual machine
 * scale set (ARM type
 * `Microsoft.Compute/virtualMachineScaleSets/virtualMachines/runCommands`)
 * — runs a script through the VM agent of that instance, without SSH or
 * RDP. Any change of the script or its inputs runs it again. The deploy
 * waits for the script and, by default, fails when it exits non-zero.
 *
 * `Flexible` scale set instances are regular VMs: use
 * `Azure.Compute.VirtualMachineRunCommand` on them instead.
 *
 * :::caution
 * Changing `resourceGroup`, `virtualMachineScaleSet`, `instanceId`, `name`,
 * `location`, or `tags` replaces the run command (Azure does not update a
 * scale set VM run command's tags in place). Deleting the instance (scale-in)
 * deletes its run commands.
 * :::
 *
 * :::caution
 * A run command re-created under the same `name` on the same instance
 * reports the earlier execution's result instead of running again. Omit
 * `name` so a replacement gets a fresh one.
 * :::
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/linux/run-command-managed
 *
 * ### Running a Script
 * **Example:** Inline shell script on the first instance
 * ```typescript
 * const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("batch", {
 *   orchestrationMode: "Uniform",
 *   vmSize: "Standard_D2s_v5",
 *   subnetId: subnet.subnetId,
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 * });
 * const setup = yield* Azure.Compute.VirtualMachineScaleSetVMRunCommand("setup", {
 *   virtualMachineScaleSet: scaleSet.virtualMachineScaleSetName,
 *   instanceId: "0",
 *   script: "apt-get update && apt-get install -y nginx",
 * });
 * // setup.exitCode, setup.output
 * ```
 *
 * **Example:** Script with parameters and a secret
 * ```typescript
 * yield* Azure.Compute.VirtualMachineScaleSetVMRunCommand("configure", {
 *   virtualMachineScaleSet: scaleSet.virtualMachineScaleSetName,
 *   instanceId: "0",
 *   script: 'echo "$GREETING" > /etc/motd && echo "$TOKEN" > /etc/app-token',
 *   parameters: { GREETING: "hello" },
 *   protectedParameters: Redacted.make({ TOKEN: token }),
 * });
 * ```
 *
 * @resource
 */
export const VirtualMachineScaleSetVMRunCommand =
  GroupedResource<VirtualMachineScaleSetVMRunCommand>(
    "Azure.Compute.VirtualMachineScaleSetVMRunCommand",
  );

type Observed = compute.GetVirtualMachineScaleSetVMRunCommandResponse;

interface Where {
  readonly subscriptionId: string;
  readonly resourceGroupName: string;
  readonly vmScaleSetName: string;
  readonly instanceId: string;
  readonly runCommandName: string;
}

const getRunCommand = (where: Where) =>
  orUndefinedIfNotFound(
    compute.GetVirtualMachineScaleSetVMRunCommand({ ...where, _expand: "instanceView" }),
  );

const toAttrs = (
  resourceGroup: string,
  scaleSet: string,
  instanceId: string,
  name: string,
  command: Observed,
): VirtualMachineScaleSetVMRunCommand["Attributes"] => ({
  runCommandName: name,
  runCommandId: command.id ?? "",
  virtualMachineScaleSet: scaleSet,
  instanceId,
  resourceGroup,
  location: command.location,
  ...runCommandResult(command.properties),
  tags: userTags(command.tags),
});

export const VirtualMachineScaleSetVMRunCommandProvider = () =>
  Provider.succeed(VirtualMachineScaleSetVMRunCommand, {
    stables: [
      "runCommandName",
      "runCommandId",
      "virtualMachineScaleSet",
      "instanceId",
      "resourceGroup",
      "location",
    ],

    // Run commands are deleted with their scale set instance.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.virtualMachineScaleSet, output.virtualMachineScaleSet) ||
        news.instanceId !== output.instanceId ||
        (news.name !== undefined && news.name !== output.runCommandName) ||
        (news.location !== undefined && !sameId(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      // Tags cannot change in place (see reconcile). A kept explicit name
      // must be freed before the replacement takes it.
      if (tagsDiffer(output.tags, news.tags ?? {})) {
        return {
          action: "replace",
          deleteFirst: news.name !== undefined && news.name === output.runCommandName,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const scaleSet = output?.virtualMachineScaleSet ?? olds?.virtualMachineScaleSet;
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (resourceGroup === undefined || scaleSet === undefined || instanceId === undefined) {
        return undefined;
      }
      const name = output?.runCommandName ?? olds?.name ?? (yield* createComputeName(id));
      const observed = yield* getRunCommand({
        subscriptionId,
        resourceGroupName: resourceGroup,
        vmScaleSetName: scaleSet,
        instanceId,
        runCommandName: name,
      });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, scaleSet, instanceId, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Compute");
      const resourceGroup = news.resourceGroup;
      const scaleSet = news.virtualMachineScaleSet;
      const instanceId = news.instanceId;
      const name = news.name ?? output?.runCommandName ?? (yield* createComputeName(id));
      const location =
        news.location ??
        output?.location ??
        (yield* scaleSetLocation(subscriptionId, resourceGroup, scaleSet)) ??
        env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where: Where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vmScaleSetName: scaleSet,
        instanceId,
        runCommandName: name,
      };
      const label = `scale set VM run command ${name}`;
      const get = getRunCommand(where);

      // Observe.
      let observed = yield* get;

      // Ensure, or re-run (PUT) when the script or its inputs changed.
      if (observed === undefined || runCommandDrifted(observed.properties, news, olds)) {
        yield* compute
          .VirtualMachineScaleSetVMRunCommandsCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: runCommandInput(news),
          })
          .pipe(Effect.retry(whileComputeBusy));
      }
      // Tags are not synced: Azure keeps a scale set VM run command's
      // tags on re-PUT, and a tags-only PATCH clears its script. `diff`
      // replaces on a tag change instead.
      observed = yield* waitRunCommandFinished(label, get, news.asyncExecution);
      return toAttrs(resourceGroup, scaleSet, instanceId, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where: Where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        vmScaleSetName: output.virtualMachineScaleSet,
        instanceId: output.instanceId,
        runCommandName: output.runCommandName,
      };
      yield* ignoreNotFound(compute.DeleteVirtualMachineScaleSetVMRunCommand(where)).pipe(
        Effect.retry(whileComputeBusy),
      );
      yield* waitComputeGone(
        `scale set VM run command ${output.runCommandName}`,
        getRunCommand(where),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Compute.VirtualMachineScaleSet", "Azure.Resources.ResourceGroup"],
    },
  });
