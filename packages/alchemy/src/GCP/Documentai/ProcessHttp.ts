import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import * as Layer from "effect/Layer";
import { makeProcessorHttpBinding } from "./BindingHttp.ts";
import { Process } from "./Process.ts";

/**
 * HTTP implementation of {@link Process}.
 *
 * @layer
 * @provides GCP.Documentai.Process
 */
export const ProcessHttp = Layer.effect(
  Process,
  makeProcessorHttpBinding({
    tag: "GCP.Documentai.Process",
    operation: documentai.processProjectsLocationsProcessors,
  }),
);
