import type * as Effect from "effect/Effect";
import { type ArmActionRole, groupOf, makeArmActionBinding } from "../ArmActionBinding.ts";
import type { Compute } from "./Compute.ts";

/**
 * Shared scaffolding for the Azure Machine Learning runtime-action
 * bindings: the bound compute supplies `subscriptionId`,
 * `resourceGroupName`, `workspaceName` and `computeName`, and each binding
 * assigns its custom role on the compute only.
 *
 * NOT exported from `index.ts`.
 */

/** Machine Learning permissions the bindings grant (Azure RBAC actions). */
export const MachineLearningPermission = {
  startCompute: "Microsoft.MachineLearningServices/workspaces/computes/start/action",
  stopCompute: "Microsoft.MachineLearningServices/workspaces/computes/stop/action",
  restartCompute: "Microsoft.MachineLearningServices/workspaces/computes/restart/action",
} as const;

/**
 * Custom role per binding; the logical ID is `Azure<role>Role`. The
 * built-in **AzureML Compute Operator** also creates, edits and deletes
 * computes.
 */
export const MachineLearningRole = {
  StartCompute: {
    role: "MachineLearningStartCompute",
    actions: [MachineLearningPermission.startCompute],
  },
  StopCompute: {
    role: "MachineLearningStopCompute",
    actions: [MachineLearningPermission.stopCompute],
  },
  RestartCompute: {
    role: "MachineLearningRestartCompute",
    actions: [MachineLearningPermission.restartCompute],
  },
} as const satisfies Record<string, ArmActionRole>;

type ComputeKeys = "subscriptionId" | "resourceGroupName" | "workspaceName" | "computeName";

/**
 * Build the impl Effect for a compute action: the runtime callable fills
 * the compute's identifiers, and the deploy-time half assigns `role` on
 * the compute.
 */
export const makeComputeActionBinding = <
  I extends {
    subscriptionId: string;
    resourceGroupName: string;
    workspaceName: string;
    computeName: string;
  },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.MachineLearning.StartCompute`. */
  tag: string;
  /** The distilled `machinelearningservices` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** The custom role assigned on the compute. */
  role: ArmActionRole;
}) =>
  makeArmActionBinding({
    ...options,
    scope: (compute: Compute) => compute.computeId,
    target: (compute) => compute.computeId,
    input: (request: Omit<I, ComputeKeys> | undefined, id) =>
      ({
        ...request,
        ...groupOf(id),
        workspaceName: id.names.workspaces ?? "",
        computeName: id.names.computes ?? "",
      }) as I,
  });
