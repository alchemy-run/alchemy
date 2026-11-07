import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeProcessorHttpBinding } from "./BindingHttp.ts";
import type { Processor } from "./Processor.ts";

export interface ProcessRequest extends Omit<
  documentai.ProcessProjectsLocationsProcessorsRequest,
  "name"
> {}

/**
 * Runtime binding for Document AI `processors.process`.
 *
 * Bind this operation to a {@link Processor} in a Function/Action init
 * phase. Provide {@link ProcessHttp}.
 *
 * ### Processing a Document
 * **Example:** OCR a raw PDF
 * ```typescript
 * const process = yield* GCP.DocumentAI.Process(processor);
 * const result = yield* process({
 *   body: {
 *     rawDocument: {
 *       content: pdfBase64,
 *       mimeType: "application/pdf",
 *     },
 *     skipHumanReview: true,
 *   },
 * });
 * ```
 *
 * @binding
 * @category DocumentAI
 */
export interface Process extends Binding.Service<
  Process,
  "GCP.DocumentAI.Process",
  (
    processor: Processor,
  ) => Effect.Effect<
    (
      request?: ProcessRequest,
    ) => Effect.Effect<
      documentai.GoogleCloudDocumentaiV1ProcessResponse,
      documentai.ProcessProjectsLocationsProcessorsError,
      RuntimeContext
    >
  >
> {}

export const Process = Binding.Service<Process>("GCP.DocumentAI.Process");

/**
 * HTTP implementation of {@link Process}.
 *
 * @layer
 * @provides GCP.DocumentAI.Process
 */
export const ProcessHttp = Layer.effect(
  Process,
  makeProcessorHttpBinding({
    tag: "GCP.DocumentAI.Process",
    operation: documentai.processProjectsLocationsProcessors,
    iam: { role: "roles/documentai.apiUser" },
  }),
);
