import * as controltower from "@distilled.cloud/aws/controltower";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeControlTowerAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `controltower:ListControlOperations`.
 *
 * An account-level operation that enumerates recent control operations
 * (enables, disables, updates, and resets), optionally filtered by status,
 * control, or target. Useful for governance dashboards that surface
 * in-flight or failed guardrail deployments. Provide the implementation
 * with `Effect.provide(AWS.ControlTower.ListControlOperationsHttp)`.
 * ### Polling Asynchronous Operations
 * **Example:** List Failed Control Operations
 * ```typescript
 * // init — account-level binding takes no resource
 * const listControlOperations = yield* AWS.ControlTower.ListControlOperations();
 *
 * // runtime
 * const result = yield* listControlOperations({
 *   filter: { statuses: ["FAILED"] },
 * });
 * console.log(result.controlOperations.length);
 * ```
 *
 * @binding
 */
export interface ListControlOperations extends Binding.Service<
  ListControlOperations,
  "AWS.ControlTower.ListControlOperations",
  () => Effect.Effect<
    (
      request?: controltower.ListControlOperationsInput,
    ) => Effect.Effect<
      controltower.ListControlOperationsOutput,
      controltower.ListControlOperationsError
    >
  >
> {}

export const ListControlOperations = Binding.Service<ListControlOperations>(
  "AWS.ControlTower.ListControlOperations",
);

export const ListControlOperationsHttp = Layer.effect(
  ListControlOperations,
  makeControlTowerAccountHttpBinding({
    capability: "ListControlOperations",
    iamActions: ["controltower:ListControlOperations"],
    operation: controltower.listControlOperations,
  }),
);
