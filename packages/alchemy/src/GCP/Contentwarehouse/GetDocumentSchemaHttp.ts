import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import * as Layer from "effect/Layer";
import { makeDocumentSchemaHttpBinding } from "./BindingHttp.ts";
import { GetDocumentSchema } from "./GetDocumentSchema.ts";

/**
 * HTTP implementation of {@link GetDocumentSchema}.
 *
 * @layer
 * @provides GCP.Contentwarehouse.GetDocumentSchema
 */
export const GetDocumentSchemaHttp = Layer.effect(
  GetDocumentSchema,
  makeDocumentSchemaHttpBinding({
    tag: "GCP.Contentwarehouse.GetDocumentSchema",
    operation: cw.getProjectsLocationsDocumentSchemas,
  }),
);
