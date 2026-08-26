import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
import * as Layer from "effect/Layer";
import { makeDocumentHttpBinding } from "./BindingHttp.ts";
import { GetDocument } from "./GetDocument.ts";

/**
 * HTTP implementation of {@link GetDocument}.
 *
 * @layer
 * @provides GCP.Contentwarehouse.GetDocument
 */
export const GetDocumentHttp = Layer.effect(
  GetDocument,
  makeDocumentHttpBinding({
    tag: "GCP.Contentwarehouse.GetDocument",
    operation: cw.getProjectsLocationsDocuments,
  }),
);
