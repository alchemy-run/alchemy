import * as translate from "@distilled.cloud/gcp/translate_v3";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeModelHttpBinding } from "./BindingHttp.ts";
import type { Model } from "./Model.ts";

export interface GetModelRequest extends Omit<
  translate.GetProjectsLocationsModelsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Translation `models.get`.
 *
 * Bind this operation to a {@link Model} in a Function/Action init
 * phase. Provide {@link GetModelHttp}.
 *
 * ### Reading a Model
 * **Example:** Read the bound model
 * ```typescript
 * const getModel = yield* GCP.Translate.GetModel(model);
 * const live = yield* getModel();
 * ```
 *
 * @binding
 * @category Translate
 */
export interface GetModel extends Binding.Service<
  GetModel,
  "GCP.Translate.GetModel",
  (
    model: Model,
  ) => Effect.Effect<
    (
      request?: GetModelRequest,
    ) => Effect.Effect<translate.Model, translate.GetProjectsLocationsModelsError, RuntimeContext>
  >
> {}

export const GetModel = Binding.Service<GetModel>("GCP.Translate.GetModel");

/**
 * HTTP implementation of {@link GetModel}.
 *
 * @layer
 * @provides GCP.Translate.GetModel
 */
export const GetModelHttp = Layer.effect(
  GetModel,
  makeModelHttpBinding({
    tag: "GCP.Translate.GetModel",
    operation: translate.getProjectsLocationsModels,
    iam: { role: "roles/cloudtranslate.viewer" },
  }),
);
