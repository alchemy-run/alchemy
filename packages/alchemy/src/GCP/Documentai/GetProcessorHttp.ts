import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import * as Layer from "effect/Layer";
import { makeProcessorHttpBinding } from "./BindingHttp.ts";
import { GetProcessor } from "./GetProcessor.ts";

/**
 * HTTP implementation of {@link GetProcessor}.
 *
 * @layer
 * @provides GCP.Documentai.GetProcessor
 */
export const GetProcessorHttp = Layer.effect(
  GetProcessor,
  makeProcessorHttpBinding({
    tag: "GCP.Documentai.GetProcessor",
    operation: documentai.getProjectsLocationsProcessors,
  }),
);
