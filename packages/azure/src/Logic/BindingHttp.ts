import type * as Effect from "effect/Effect";
import { type ArmActionRole, groupOf, makeArmActionBinding } from "../ArmActionBinding.ts";
import type { Workflow } from "./Workflow.ts";

/**
 * Shared scaffolding for the Logic Apps runtime-action bindings: the bound
 * workflow supplies `subscriptionId`, `resourceGroupName` and
 * `workflowName`, and each binding assigns its custom role on the
 * workflow only.
 *
 * NOT exported from `index.ts`.
 */

/** Logic Apps permissions the bindings grant (Azure RBAC actions). */
export const LogicPermission = {
  runTrigger: "Microsoft.Logic/workflows/triggers/run/action",
  resetTrigger: "Microsoft.Logic/workflows/triggers/reset/action",
  cancelRun: "Microsoft.Logic/workflows/runs/cancel/action",
} as const;

/**
 * Custom role per binding; the logical ID is `Azure<role>Role`. The
 * built-in **Logic App Operator** also reads every workflow, run and
 * trigger history; **Logic App Contributor** also edits the workflow.
 */
export const LogicRole = {
  RunWorkflowTrigger: {
    role: "LogicRunWorkflowTrigger",
    actions: [LogicPermission.runTrigger],
  },
  ResetWorkflowTrigger: {
    role: "LogicResetWorkflowTrigger",
    actions: [LogicPermission.resetTrigger],
  },
  CancelWorkflowRun: {
    role: "LogicCancelWorkflowRun",
    actions: [LogicPermission.cancelRun],
  },
} as const satisfies Record<string, ArmActionRole>;

/**
 * Build the impl Effect for a workflow action: the runtime callable fills
 * the workflow's identifiers, and the deploy-time half assigns `role` on
 * the workflow.
 */
export const makeWorkflowActionBinding = <
  I extends { subscriptionId: string; resourceGroupName: string; workflowName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Logic.RunWorkflowTrigger`. */
  tag: string;
  /** The distilled `logic` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** The custom role assigned on the workflow. */
  role: ArmActionRole;
}) =>
  makeArmActionBinding({
    ...options,
    scope: (workflow: Workflow) => workflow.workflowId,
    target: (workflow) => workflow.workflowId,
    input: (request: Omit<I, "subscriptionId" | "resourceGroupName" | "workflowName">, id) =>
      ({ ...request, ...groupOf(id), workflowName: id.names.workflows ?? "" }) as I,
  });
