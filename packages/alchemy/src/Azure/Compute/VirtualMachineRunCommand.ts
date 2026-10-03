import * as compute from "@distilled.cloud/azure/compute";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
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
import {
  createComputeName,
  runCommandDrifted,
  runCommandInput,
  runCommandResult,
  sameId,
  vmLocation,
  waitComputeGone,
  waitComputeProvisioned,
  whileComputeBusy,
  type RunCommandSourceProps,
} from "./common.ts";

export interface VirtualMachineRunCommandProps extends RunCommandSourceProps {
  /**
   * Resource group of the VM. Changing it replaces the run command.
   */
  resourceGroup: string;
  /**
   * Name of the VM the command runs on. Changing it replaces the run
   * command.
   */
  virtualMachine: string;
  /**
   * Name of the run command. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the run command.
   */
  name?: string;
  /**
   * Location of the VM.
   * @default the VM's location
   */
  location?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface VirtualMachineRunCommand extends Resource<
  "Azure.Compute.VirtualMachineRunCommand",
  VirtualMachineRunCommandProps,
  {
    /** Name of the run command. */
    runCommandName: string;
    /** ARM resource ID of the run command. */
    runCommandId: string;
    /** Name of the VM. */
    virtualMachine: string;
    /** Resource group of the VM. */
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
 * A managed run command on an Azure virtual machine — runs a script through
 * the VM agent, without SSH or RDP. Any change of the script or its inputs
 * runs it again. The deploy waits for the script and, by default, fails
 * when it exits non-zero.
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/linux/run-command-managed
 *
 * ### Running a Script
 * **Example:** Inline shell script
 * ```typescript
 * const setup = yield* Azure.Compute.VirtualMachineRunCommand("setup", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachine: vm.virtualMachineName,
 *   script: "apt-get update && apt-get install -y nginx",
 * });
 * // setup.exitCode, setup.output
 * ```
 *
 * **Example:** Script with parameters and a secret
 * ```typescript
 * yield* Azure.Compute.VirtualMachineRunCommand("configure", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachine: vm.virtualMachineName,
 *   script: 'echo "$GREETING" > /etc/motd && echo "$TOKEN" > /etc/app-token',
 *   parameters: { GREETING: "hello" },
 *   protectedParameters: Redacted.make({ TOKEN: token }),
 * });
 * ```
 *
 * ### Fire and Forget
 * **Example:** Long-running script that does not block the deploy
 * ```typescript
 * yield* Azure.Compute.VirtualMachineRunCommand("warmup", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachine: vm.virtualMachineName,
 *   script: "/opt/app/warmup.sh",
 *   asyncExecution: true,
 *   treatFailureAsDeploymentFailure: false,
 * });
 * ```
 *
 * @resource
 */
export const VirtualMachineRunCommand = Resource<VirtualMachineRunCommand>(
  "Azure.Compute.VirtualMachineRunCommand",
);

type Observed = compute.GetVirtualMachineRunCommandByVirtualMachineResponse;

const getRunCommand = (
  subscriptionId: string,
  resourceGroupName: string,
  vmName: string,
  runCommandName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetVirtualMachineRunCommandByVirtualMachine({
      subscriptionId,
      resourceGroupName,
      vmName,
      runCommandName,
      _expand: "instanceView",
    }),
  );

const toAttrs = (
  resourceGroup: string,
  vmName: string,
  name: string,
  command: Observed,
): VirtualMachineRunCommand["Attributes"] => ({
  runCommandName: name,
  runCommandId: command.id ?? "",
  virtualMachine: vmName,
  resourceGroup,
  location: command.location,
  ...runCommandResult(command.properties),
  tags: userTags(command.tags),
});

export const VirtualMachineRunCommandProvider = () =>
  Provider.succeed(VirtualMachineRunCommand, {
    stables: [
      "runCommandName",
      "runCommandId",
      "virtualMachine",
      "resourceGroup",
      "location",
    ],

    // Run commands are deleted with their VM.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.virtualMachine, output.virtualMachine) ||
        (news.name !== undefined && news.name !== output.runCommandName) ||
        (news.location !== undefined && !sameId(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vmName = output?.virtualMachine ?? olds?.virtualMachine;
      if (resourceGroup === undefined || vmName === undefined) return undefined;
      const name =
        output?.runCommandName ?? olds?.name ?? (yield* createComputeName(id));
      const observed = yield* getRunCommand(
        subscriptionId,
        resourceGroup,
        vmName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, vmName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Compute");
      const resourceGroup = news.resourceGroup;
      const vmName = news.virtualMachine;
      const name =
        news.name ?? output?.runCommandName ?? (yield* createComputeName(id));
      const location =
        news.location ??
        output?.location ??
        (yield* vmLocation(subscriptionId, resourceGroup, vmName)) ??
        env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vmName,
        runCommandName: name,
      };
      const label = `run command ${name}`;
      const get = getRunCommand(subscriptionId, resourceGroup, vmName, name);

      // Observe.
      let observed = yield* get;

      // Ensure, or re-run (PUT) when the script or its inputs changed.
      if (
        observed === undefined ||
        runCommandDrifted(observed.properties, news, olds)
      ) {
        yield* compute
          .VirtualMachineRunCommandsCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: runCommandInput(news),
          })
          .pipe(Effect.retry(whileComputeBusy));
      }
      observed = yield* waitComputeProvisioned(label, get);

      // Sync tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* compute
          .UpdateVirtualMachineRunCommand({ ...where, tags })
          .pipe(Effect.retry(whileComputeBusy));
        observed = yield* waitComputeProvisioned(label, get);
      }
      return toAttrs(resourceGroup, vmName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteVirtualMachineRunCommand({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vmName: output.virtualMachine,
          runCommandName: output.runCommandName,
        }),
      ).pipe(Effect.retry(whileComputeBusy));
      yield* waitComputeGone(
        `run command ${output.runCommandName}`,
        getRunCommand(
          subscriptionId,
          output.resourceGroup,
          output.virtualMachine,
          output.runCommandName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Compute.VirtualMachine",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
