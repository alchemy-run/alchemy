import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeNamedHttpBinding } from "./BindingHttp.ts";
import type { ReasoningEngine } from "./ReasoningEngine.ts";

export interface GetReasoningEngineRequest extends Omit<
  aiplatform.GetReasoningEnginesRequest,
  "name"
> {}

/**
 * Runtime binding for Vertex AI `reasoningEngines.get`.
 *
 * Bind this operation to a {@link ReasoningEngine} in a Function/Action
 * init phase. Provide {@link GetReasoningEngineHttp}.
 *
 * ### Observing Engines
 * **Example:** Read the bound engine
 * ```typescript
 * const getEngine = yield* GCP.AIPlatform.GetReasoningEngine(engine);
 * const live = yield* getEngine();
 * ```
 *
 * @binding
 * @category AIPlatform
 */
export interface GetReasoningEngine extends Binding.Service<
  GetReasoningEngine,
  "GCP.AIPlatform.GetReasoningEngine",
  (
    engine: ReasoningEngine,
  ) => Effect.Effect<
    (
      request?: GetReasoningEngineRequest,
    ) => Effect.Effect<
      aiplatform.GoogleCloudAiplatformV1ReasoningEngine,
      aiplatform.GetReasoningEnginesError,
      RuntimeContext
    >
  >
> {}

export const GetReasoningEngine = Binding.Service<GetReasoningEngine>(
  "GCP.AIPlatform.GetReasoningEngine",
);

/**
 * HTTP implementation of {@link GetReasoningEngine}.
 *
 * @layer
 * @provides GCP.AIPlatform.GetReasoningEngine
 */
export const GetReasoningEngineHttp = Layer.effect(
  GetReasoningEngine,
  makeNamedHttpBinding<
    ReasoningEngine,
    aiplatform.GetReasoningEnginesRequest,
    aiplatform.GoogleCloudAiplatformV1ReasoningEngine,
    aiplatform.GetReasoningEnginesError
  >({
    tag: "GCP.AIPlatform.GetReasoningEngine",
    operation: aiplatform.getReasoningEngines,
    iam: { role: "roles/aiplatform.viewer" },
  }),
);
