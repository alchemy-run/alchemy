import type * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { VirtualMachine } from "./VirtualMachine.ts";
import type { VirtualMachineScaleSet } from "./VirtualMachineScaleSet.ts";

/**
 * Shared scaffolding for the Compute runtime-action bindings (start, stop,
 * restart a VM or scale set from a running host). NOT exported from
 * `index.ts`: every `{Op}Http.ts` is a thin `Layer.effect(Cap, make…({ … }))`.
 *
 * The built-in **Virtual Machine Contributor** grants every
 * `Microsoft.Compute/virtualMachines/*` action (and NIC and disk writes), so
 * each binding kind gets a custom role (`Azure.Authorization.RoleDefinition`,
 * one per stack, defined at the subscription) with exactly its action,
 * assigned only on the bound VM or scale set.
 */

const VMS = "Microsoft.Compute/virtualMachines";
const VMSS = "Microsoft.Compute/virtualMachineScaleSets";

/** A custom role a binding assigns on its resource; the logical ID is `AzureCompute<role>Role`. */
export interface ComputeGrant {
  readonly role: string;
  readonly actions: readonly string[];
}

/** Custom role per runtime action (Azure RBAC operation names). */
export const ComputeRole = {
  VirtualMachineStart: { role: "VirtualMachineStart", actions: [`${VMS}/start/action`] },
  VirtualMachinePowerOff: { role: "VirtualMachinePowerOff", actions: [`${VMS}/powerOff/action`] },
  VirtualMachineDeallocate: {
    role: "VirtualMachineDeallocate",
    actions: [`${VMS}/deallocate/action`],
  },
  VirtualMachineRestart: { role: "VirtualMachineRestart", actions: [`${VMS}/restart/action`] },
  VirtualMachineRedeploy: { role: "VirtualMachineRedeploy", actions: [`${VMS}/redeploy/action`] },
  VirtualMachineRunCommand: {
    role: "VirtualMachineRunCommand",
    actions: [`${VMS}/runCommand/action`],
  },
  ScaleSetStart: { role: "ScaleSetStart", actions: [`${VMSS}/start/action`] },
  ScaleSetPowerOff: { role: "ScaleSetPowerOff", actions: [`${VMSS}/powerOff/action`] },
  ScaleSetDeallocate: { role: "ScaleSetDeallocate", actions: [`${VMSS}/deallocate/action`] },
  ScaleSetRestart: { role: "ScaleSetRestart", actions: [`${VMSS}/restart/action`] },
  ScaleSetRedeploy: { role: "ScaleSetRedeploy", actions: [`${VMSS}/redeploy/action`] },
} as const satisfies Record<string, ComputeGrant>;

/** Attach the binding to its host and assign `grant` on the bound resource. */
const GrantOnResource = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    resource: ResourceLike,
    scope: Output.Output<string, never>,
    grant: ComputeGrant,
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const role = yield* AzureRoleDefinition(`AzureCompute${grant.role}Role`, {
        description: `Alchemy Compute binding: ${grant.actions.join(", ")}`,
        permissions: [{ actions: [...grant.actions] }],
      });
      yield* bind`${tag}(${resource})`({
        roleAssignments: [{ roleDefinitionId: role.roleDefinitionId, scope }],
      });
    }
  });
});

/** Subscription, resource group, and name of an ARM resource ID. */
const parseResourceId = (resourceId: string) => {
  const parts = resourceId.split("/");
  return {
    subscriptionId: parts[2] ?? "",
    resourceGroupName: parts[4] ?? "",
    name: parts[parts.length - 1] ?? "",
  };
};

/** A distilled operation, resolved with the host's credentials. */
type Operation<I, A, E> = Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;

type VirtualMachineKeys = "subscriptionId" | "resourceGroupName" | "vmName";

/**
 * Build the impl Effect for an action on a {@link VirtualMachine}: the
 * runtime callable injects the VM's subscription, resource group, and name
 * (parsed from its ARM ID), and the deploy-time half assigns `grant` on the
 * VM.
 */
export const makeVirtualMachineActionBinding = <
  I extends { subscriptionId: string; resourceGroupName: string; vmName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Compute.StartVirtualMachine`. */
  tag: string;
  /** The distilled operation; the VM's identifiers are injected. */
  operation: Operation<I, A, E>;
  /** Custom role assigned on the VM. */
  grant: ComputeGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnResource;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (vm: VirtualMachine) {
      yield* grant(options.tag, vm, vm.virtualMachineId, options.grant);
      const virtualMachineId = yield* vm.virtualMachineId;
      return Effect.fn(`${options.tag}(${vm.LogicalId})`)(function* (
        request?: Omit<I, VirtualMachineKeys>,
      ) {
        const id = yield* virtualMachineId;
        const { subscriptionId, resourceGroupName, name } = parseResourceId(id);
        // `Omit<I, K> & Pick<I, K>` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, subscriptionId, resourceGroupName, vmName: name } as I);
      });
    });
  });

type ScaleSetKeys = "subscriptionId" | "resourceGroupName" | "vmScaleSetName";

/**
 * Build the impl Effect for an action on a {@link VirtualMachineScaleSet}:
 * the runtime callable injects the scale set's subscription, resource
 * group, and name, and the deploy-time half assigns `grant` on the scale
 * set.
 */
export const makeScaleSetActionBinding = <
  I extends { subscriptionId: string; resourceGroupName: string; vmScaleSetName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Compute.StartVirtualMachineScaleSet`. */
  tag: string;
  /** The distilled operation; the scale set's identifiers are injected. */
  operation: Operation<I, A, E>;
  /** Custom role assigned on the scale set. */
  grant: ComputeGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnResource;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (scaleSet: VirtualMachineScaleSet) {
      yield* grant(options.tag, scaleSet, scaleSet.virtualMachineScaleSetId, options.grant);
      const scaleSetId = yield* scaleSet.virtualMachineScaleSetId;
      return Effect.fn(`${options.tag}(${scaleSet.LogicalId})`)(function* (
        request?: Omit<I, ScaleSetKeys>,
      ) {
        const id = yield* scaleSetId;
        const { subscriptionId, resourceGroupName, name } = parseResourceId(id);
        // `Omit<I, K> & Pick<I, K>` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({
          ...request,
          subscriptionId,
          resourceGroupName,
          vmScaleSetName: name,
        } as I);
      });
    });
  });
