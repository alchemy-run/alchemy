import type * as Effect from "effect/Effect";
import { type ArmActionRole, groupOf, makeArmActionBinding } from "../ArmActionBinding.ts";
import type { VirtualMachine } from "./VirtualMachine.ts";

/**
 * Shared scaffolding for the DevTest Labs runtime-action bindings: the
 * bound lab VM supplies `subscriptionId`, `resourceGroupName`, `labName`
 * and `name`, and each binding assigns its custom role on the lab VM only.
 *
 * NOT exported from `index.ts`.
 */

/** DevTest Labs permissions the bindings grant (Azure RBAC actions). */
export const DevTestLabsPermission = {
  start: "Microsoft.DevTestLab/labs/virtualMachines/Start/action",
  stop: "Microsoft.DevTestLab/labs/virtualMachines/Stop/action",
  restart: "Microsoft.DevTestLab/labs/virtualMachines/Restart/action",
  redeploy: "Microsoft.DevTestLab/labs/virtualMachines/Redeploy/action",
} as const;

/**
 * Custom role per binding; the logical ID is `Azure<role>Role`. The
 * built-in **DevTest Labs User** also claims, creates and deletes lab VMs.
 */
export const DevTestLabsRole = {
  StartVirtualMachine: {
    role: "DevTestLabsStartVirtualMachine",
    actions: [DevTestLabsPermission.start],
  },
  StopVirtualMachine: {
    role: "DevTestLabsStopVirtualMachine",
    actions: [DevTestLabsPermission.stop],
  },
  RestartVirtualMachine: {
    role: "DevTestLabsRestartVirtualMachine",
    actions: [DevTestLabsPermission.restart],
  },
  RedeployVirtualMachine: {
    role: "DevTestLabsRedeployVirtualMachine",
    actions: [DevTestLabsPermission.redeploy],
  },
} as const satisfies Record<string, ArmActionRole>;

/**
 * Build the impl Effect for a lab VM action: the runtime callable fills the
 * VM's identifiers, and the deploy-time half assigns `role` on the VM.
 */
export const makeLabVirtualMachineActionBinding = <
  I extends { subscriptionId: string; resourceGroupName: string; labName: string; name: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.DevTestLabs.StartVirtualMachine`. */
  tag: string;
  /** The distilled `devtestlabs` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** The custom role assigned on the lab VM. */
  role: ArmActionRole;
}) =>
  makeArmActionBinding({
    ...options,
    scope: (vm: VirtualMachine) => vm.virtualMachineId,
    target: (vm) => vm.virtualMachineId,
    input: (
      request: Omit<I, "subscriptionId" | "resourceGroupName" | "labName" | "name"> | undefined,
      id,
    ) =>
      ({
        ...request,
        ...groupOf(id),
        labName: id.names.labs ?? "",
        name: id.names.virtualmachines ?? "",
      }) as I,
  });
