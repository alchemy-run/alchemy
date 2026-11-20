import * as ml from "@distilled.cloud/gcp/ml_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModelHttpBinding } from "./BindingHttp.ts";
import type { Model } from "./Model.ts";

export interface GetModelRequest extends Omit<ml.GetProjectsModelsRequest, "name"> {}

/**
 * Runtime binding for AI Platform (legacy ML Engine) `models.get`.
 *
 * Bind this operation to a {@link Model} in a Function/Action init
 * phase. Provide {@link GetModelHttp}.
 *
 * ### Reading a Model
 * **Example:** Get the bound model
 * ```typescript
 * const getModel = yield* GCP.ML.GetModel(model);
 * const live = yield* getModel();
 * ```
 *
 * @binding
 * @category ML
 */
export interface GetModel extends Binding.Service<
  GetModel,
  "GCP.ML.GetModel",
  (
    model: Model,
  ) => Effect.Effect<
    (
      request?: GetModelRequest,
    ) => Effect.Effect<ml.GoogleCloudMlV1__Model, ml.GetProjectsModelsError, RuntimeContext>
  >
> {}

export const GetModel = Binding.Service<GetModel>("GCP.ML.GetModel");

/**
 * HTTP implementation of {@link GetModel}.
 *
 * @layer
 * @provides GCP.ML.GetModel
 */
export const GetModelHttp = Layer.effect(
  GetModel,
  makeModelHttpBinding({
    tag: "GCP.ML.GetModel",
    operation: ml.getProjectsModels,
    iam: { role: "roles/ml.modelUser", on: "ml.model" },
  }),
);
