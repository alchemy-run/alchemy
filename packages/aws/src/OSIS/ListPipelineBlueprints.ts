import * as osis from "@distilled.cloud/aws/osis";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOsisAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `osis:ListPipelineBlueprints`.
 *
 * Lists the available Data Prepper blueprints — AWS-provided configuration
 * templates for common source/sink topologies — so config-authoring tooling
 * can offer them as starting points. Account-level: no resource argument.
 * Provide the implementation with
 * `Effect.provide(AWS.OSIS.ListPipelineBlueprintsHttp)`.
 * ### Authoring Pipeline Configurations
 * **Example:** List Available Blueprints
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listPipelineBlueprints = yield* AWS.OSIS.ListPipelineBlueprints();
 *
 * // runtime
 * const { Blueprints } = yield* listPipelineBlueprints();
 * // [{ BlueprintName: "AWS-CloudTrailLogsToOpenSearch", ... }, ...]
 * ```
 *
 * @binding
 */
export interface ListPipelineBlueprints extends Binding.Service<
  ListPipelineBlueprints,
  "AWS.OSIS.ListPipelineBlueprints",
  () => Effect.Effect<
    (
      request?: osis.ListPipelineBlueprintsRequest,
    ) => Effect.Effect<osis.ListPipelineBlueprintsResponse, osis.ListPipelineBlueprintsError>
  >
> {}
export const ListPipelineBlueprints = Binding.Service<ListPipelineBlueprints>(
  "AWS.OSIS.ListPipelineBlueprints",
);

export const ListPipelineBlueprintsHttp = Layer.effect(
  ListPipelineBlueprints,
  makeOsisAccountHttpBinding({
    tag: "AWS.OSIS.ListPipelineBlueprints",
    operation: osis.listPipelineBlueprints,
    actions: ["osis:ListPipelineBlueprints"],
  }),
);
