import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeProcessorHttpBinding } from "./BindingHttp.ts";
import type { Processor } from "./Processor.ts";

export interface GetProcessorRequest extends Omit<
  documentai.GetProjectsLocationsProcessorsRequest,
  "name"
> {}

/**
 * Runtime binding for Document AI `processors.get`.
 *
 * Bind this operation to a {@link Processor} in a Function/Action init
 * phase. Provide {@link GetProcessorHttp}.
 *
 * ### Reading a Processor
 * **Example:** Read the bound processor
 * ```typescript
 * const getProcessor = yield* GCP.DocumentAI.GetProcessor(processor);
 * const live = yield* getProcessor();
 * ```
 *
 * @binding
 * @category DocumentAI
 */
export interface GetProcessor extends Binding.Service<
  GetProcessor,
  "GCP.DocumentAI.GetProcessor",
  (
    processor: Processor,
  ) => Effect.Effect<
    (
      request?: GetProcessorRequest,
    ) => Effect.Effect<
      documentai.GoogleCloudDocumentaiV1Processor,
      documentai.GetProjectsLocationsProcessorsError,
      RuntimeContext
    >
  >
> {}

export const GetProcessor = Binding.Service<GetProcessor>("GCP.DocumentAI.GetProcessor");

/**
 * HTTP implementation of {@link GetProcessor}.
 *
 * @layer
 * @provides GCP.DocumentAI.GetProcessor
 */
export const GetProcessorHttp = Layer.effect(
  GetProcessor,
  makeProcessorHttpBinding({
    tag: "GCP.DocumentAI.GetProcessor",
    operation: documentai.getProjectsLocationsProcessors,
    iam: { role: "roles/documentai.viewer" },
  }),
);
