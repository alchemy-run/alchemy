import * as documentai from "@distilled.cloud/gcp/documentai_v1";
import * as Layer from "effect/Layer";
import { makeSchemaHttpBinding } from "./BindingHttp.ts";
import { GetSchema } from "./GetSchema.ts";

/**
 * HTTP implementation of {@link GetSchema}.
 *
 * @layer
 * @provides GCP.Documentai.GetSchema
 */
export const GetSchemaHttp = Layer.effect(
  GetSchema,
  makeSchemaHttpBinding({
    tag: "GCP.Documentai.GetSchema",
    operation: documentai.getProjectsLocationsSchemas,
  }),
);
