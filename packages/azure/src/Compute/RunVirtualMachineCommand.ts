import type * as compute from "@distilled.cloud/azure/compute";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VirtualMachine } from "./VirtualMachine.ts";

/** `RunVirtualMachineCommand` request without the VM's identifiers, which the bound VM supplies. */
export interface RunVirtualMachineCommandRequest extends Omit<
  compute.RunVirtualMachineCommandRequest,
  "subscriptionId" | "resourceGroupName" | "vmName"
> {}

/**
 * Run a shell script (or a predefined command) on a virtual machine through
 * its VM agent. Azure accepts the request and runs the command in the
 * background (HTTP 202): the response carries the status monitor `location`,
 * not the script output.
 *
 * Binding assigns a custom role (`AzureComputeVirtualMachineRunCommandRole`, one per stack) with exactly
 * the action `Microsoft.Compute/virtualMachines/runCommand/action`, on the VM only. The
 * smallest built-in role, **Virtual Machine Contributor**, also creates, updates, and deletes VMs, disks, and NICs.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * calls run as that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RunVirtualMachineCommandHttp}.
 *
 * ### Calling RunVirtualMachineCommand
 * **Example:** RunVirtualMachineCommand from a Function
 * ```typescript
 * const Vm = Azure.Compute.VirtualMachine("Vm", { … });
 *
 * export default class Ops extends Azure.Functions.Function<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vm = yield* Vm;
 *     const runCommand = yield* Azure.Compute.RunVirtualMachineCommand(vm);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* runCommand({ commandId: "RunShellScript", script: ["systemctl restart app"] });
 *         return HttpServerResponse.text("accepted");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Compute.RunVirtualMachineCommandHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Compute
 */
export interface RunVirtualMachineCommand extends Binding.Service<
  RunVirtualMachineCommand,
  "Azure.Compute.RunVirtualMachineCommand",
  (
    vm: VirtualMachine,
  ) => Effect.Effect<
    (
      request: RunVirtualMachineCommandRequest,
    ) => Effect.Effect<
      compute.RunCommandResult,
      compute.RunVirtualMachineCommandError,
      RuntimeContext
    >
  >
> {}

export const RunVirtualMachineCommand = Binding.Service<RunVirtualMachineCommand>(
  "Azure.Compute.RunVirtualMachineCommand",
);
