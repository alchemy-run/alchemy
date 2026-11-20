import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeNamedHttpBinding } from "./BindingHttp.ts";
import type { ReasoningEngine } from "./ReasoningEngine.ts";

export interface QueryReasoningEngineRequest extends Omit<
  aiplatform.QueryReasoningEnginesRequest,
  "name"
> {}

/**
 * Runtime binding for Vertex AI `reasoningEngines.query`.
 *
 * Bind this operation to a {@link ReasoningEngine} in a Function/Action
 * init phase. Provide {@link QueryReasoningEngineHttp}.
 *
 * ### Querying
 * **Example:** Call the default query method
 * ```typescript
 * const query = yield* GCP.AIPlatform.QueryReasoningEngine(engine);
 * const result = yield* query({
 *   body: { input: { input: "hello" } },
 * });
 * ```
 *
 * @binding
 * @category AIPlatform
 */
export interface QueryReasoningEngine extends Binding.Service<
  QueryReasoningEngine,
  "GCP.AIPlatform.QueryReasoningEngine",
  (
    engine: ReasoningEngine,
  ) => Effect.Effect<
    (
      request?: QueryReasoningEngineRequest,
    ) => Effect.Effect<
      aiplatform.GoogleCloudAiplatformV1QueryReasoningEngineResponse,
      aiplatform.QueryReasoningEnginesError,
      RuntimeContext
    >
  >
> {}

export const QueryReasoningEngine = Binding.Service<QueryReasoningEngine>(
  "GCP.AIPlatform.QueryReasoningEngine",
);

/**
 * HTTP implementation of {@link QueryReasoningEngine}.
 *
 * @layer
 * @provides GCP.AIPlatform.QueryReasoningEngine
 */
export const QueryReasoningEngineHttp = Layer.effect(
  QueryReasoningEngine,
  makeNamedHttpBinding<
    ReasoningEngine,
    aiplatform.QueryReasoningEnginesRequest,
    aiplatform.GoogleCloudAiplatformV1QueryReasoningEngineResponse,
    aiplatform.QueryReasoningEnginesError
  >({
    tag: "GCP.AIPlatform.QueryReasoningEngine",
    operation: aiplatform.queryReasoningEngines,
    iam: { role: "roles/aiplatform.viewer" },
  }),
);
