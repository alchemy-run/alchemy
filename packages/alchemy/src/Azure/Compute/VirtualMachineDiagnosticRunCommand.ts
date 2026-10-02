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

export interface VirtualMachineDiagnosticRunCommandProps extends RunCommandSourceProps {
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

export interface VirtualMachineDiagnosticRunCommand extends Resource<
  "Azure.Compute.VirtualMachineDiagnosticRunCommand",
  VirtualMachineDiagnosticRunCommandProps,
  {
    /** Name of the diagnostic run command. */
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
 * A diagnostic run command on an Azure virtual machine — runs one of the
 * platform-provided Fleet Diagnostics commands through the VM agent, using
 * the same contract as `Azure.Compute.VirtualMachineRunCommand` but on the
 * `diagnosticRunCommands` surface. Any change of its inputs runs it again.
 *
 * Azure only accepts `commandId: "FleetDiagnosticsLinux"` or
 * `"FleetDiagnosticsWindows"` here (a missing or other command ID fails
 * with `BadRequest`). The command expects the Fleet Diagnostics agent on
 * the VM; on a stock image it exits 127.
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/run-command-overview
 *
 * ### Running Fleet Diagnostics
 * **Example:** Linux diagnostics that report instead of failing the deploy
 * ```typescript
 * const diag = yield* Azure.Compute.VirtualMachineDiagnosticRunCommand("diag", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachine: vm.virtualMachineName,
 *   commandId: "FleetDiagnosticsLinux",
 *   treatFailureAsDeploymentFailure: false,
 * });
 * // diag.executionState, diag.exitCode, diag.output, diag.error
 * ```
 *
 * **Example:** Windows diagnostics streamed to a blob
 * ```typescript
 * yield* Azure.Compute.VirtualMachineDiagnosticRunCommand("diag", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachine: vm.virtualMachineName,
 *   commandId: "FleetDiagnosticsWindows",
 *   outputBlobUri: outputBlobSasUrl,
 * });
 * ```
 *
 * @resource
 */
export const VirtualMachineDiagnosticRunCommand =
  Resource<VirtualMachineDiagnosticRunCommand>(
    "Azure.Compute.VirtualMachineDiagnosticRunCommand",
  );

type Observed =
  compute.GetVirtualMachineDiagnosticRunCommandByVirtualMachineResponse;

const getRunCommand = (
  subscriptionId: string,
  resourceGroupName: string,
  vmName: string,
  runCommandName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetVirtualMachineDiagnosticRunCommandByVirtualMachine({
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
): VirtualMachineDiagnosticRunCommand["Attributes"] => ({
  runCommandName: name,
  runCommandId: command.id ?? "",
  virtualMachine: vmName,
  resourceGroup,
  location: command.location,
  ...runCommandResult(command.properties),
  tags: userTags(command.tags),
});

export const VirtualMachineDiagnosticRunCommandProvider = () =>
  Provider.succeed(VirtualMachineDiagnosticRunCommand, {
    stables: [
      "runCommandName",
      "runCommandId",
      "virtualMachine",
      "resourceGroup",
      "location",
    ],

    // Diagnostic run commands are deleted with their VM.
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
      const label = `diagnostic run command ${name}`;
      const get = getRunCommand(subscriptionId, resourceGroup, vmName, name);

      // Observe.
      let observed = yield* get;

      // Ensure, or re-run (PUT) when the script or its inputs changed.
      if (
        observed === undefined ||
        runCommandDrifted(observed.properties, news, olds)
      ) {
        yield* compute
          .VirtualMachineDiagnosticRunCommandsCreateOrUpdate({
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
          .UpdateVirtualMachineDiagnosticRunCommand({ ...where, tags })
          .pipe(Effect.retry(whileComputeBusy));
        observed = yield* waitComputeProvisioned(label, get);
      }
      return toAttrs(resourceGroup, vmName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteVirtualMachineDiagnosticRunCommand({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vmName: output.virtualMachine,
          runCommandName: output.runCommandName,
        }),
      ).pipe(Effect.retry(whileComputeBusy));
      yield* waitComputeGone(
        `diagnostic run command ${output.runCommandName}`,
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
