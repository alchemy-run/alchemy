import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeNamedHttpBinding } from "./BindingHttp.ts";
import type { ReasoningEnginesSandboxEnvironment } from "./ReasoningEnginesSandboxEnvironment.ts";

export interface ResumeSandboxEnvironmentRequest extends Omit<
  aiplatform.ResumeReasoningEnginesSandboxEnvironmentsRequest,
  "name"
> {}

/**
 * Runtime binding for Vertex AI `sandboxEnvironments.resume`.
 *
 * Bind this operation to a {@link ReasoningEnginesSandboxEnvironment} in
 * a Function/Action init phase. Provide {@link ResumeSandboxEnvironmentHttp}.
 *
 * ### Resuming
 * **Example:** Resume the bound sandbox
 * ```typescript
 * const resume = yield* GCP.AIPlatform.ResumeSandboxEnvironment(sandbox);
 * yield* resume({ body: {} });
 * ```
 *
 * @binding
 * @category AIPlatform
 */
export interface ResumeSandboxEnvironment extends Binding.Service<
  ResumeSandboxEnvironment,
  "GCP.AIPlatform.ResumeSandboxEnvironment",
  (
    sandbox: ReasoningEnginesSandboxEnvironment,
  ) => Effect.Effect<
    (
      request?: ResumeSandboxEnvironmentRequest,
    ) => Effect.Effect<
      aiplatform.GoogleLongrunningOperation,
      aiplatform.ResumeReasoningEnginesSandboxEnvironmentsError,
      RuntimeContext
    >
  >
> {}

export const ResumeSandboxEnvironment = Binding.Service<ResumeSandboxEnvironment>(
  "GCP.AIPlatform.ResumeSandboxEnvironment",
);

/**
 * HTTP implementation of {@link ResumeSandboxEnvironment}.
 *
 * @layer
 * @provides GCP.AIPlatform.ResumeSandboxEnvironment
 */
export const ResumeSandboxEnvironmentHttp = Layer.effect(
  ResumeSandboxEnvironment,
  makeNamedHttpBinding<
    ReasoningEnginesSandboxEnvironment,
    aiplatform.ResumeReasoningEnginesSandboxEnvironmentsRequest,
    aiplatform.GoogleLongrunningOperation,
    aiplatform.ResumeReasoningEnginesSandboxEnvironmentsError
  >({
    tag: "GCP.AIPlatform.ResumeSandboxEnvironment",
    operation: aiplatform.resumeReasoningEnginesSandboxEnvironments,
    iam: { role: "roles/aiplatform.user" },
  }),
);
