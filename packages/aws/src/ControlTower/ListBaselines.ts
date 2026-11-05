import * as controltower from "@distilled.cloud/aws/controltower";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeControlTowerAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `controltower:ListBaselines`.
 *
 * An account-level operation that enumerates the Control Tower baseline
 * catalog (e.g. `AWSControlTowerBaseline`, `AuditBaseline`,
 * `LogArchiveBaseline`). Useful for governance functions that discover the
 * baseline ARN to enable on an organizational unit. Provide the
 * implementation with `Effect.provide(AWS.ControlTower.ListBaselinesHttp)`.
 * ### Browsing the Baseline Catalog
 * **Example:** List the Available Baselines
 * ```typescript
 * // init — account-level binding takes no resource
 * const listBaselines = yield* AWS.ControlTower.ListBaselines();
 *
 * // runtime
 * const result = yield* listBaselines();
 * const ouBaseline = result.baselines.find(
 *   (b) => b.name === "AWSControlTowerBaseline",
 * );
 * ```
 *
 * @binding
 */
export interface ListBaselines extends Binding.Service<
  ListBaselines,
  "AWS.ControlTower.ListBaselines",
  () => Effect.Effect<
    (
      request?: controltower.ListBaselinesInput,
    ) => Effect.Effect<controltower.ListBaselinesOutput, controltower.ListBaselinesError>
  >
> {}

export const ListBaselines = Binding.Service<ListBaselines>("AWS.ControlTower.ListBaselines");

export const ListBaselinesHttp = Layer.effect(
  ListBaselines,
  makeControlTowerAccountHttpBinding({
    capability: "ListBaselines",
    iamActions: ["controltower:ListBaselines"],
    operation: controltower.listBaselines,
  }),
);
