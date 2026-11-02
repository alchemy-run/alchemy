import * as data from "@distilled.cloud/stackit/opensearch_data";
import * as Layer from "effect/Layer";
import { makeIndexBinding } from "./BindingHttp.ts";
import { GetDocument, type GetDocumentRequest } from "./GetDocument.ts";

/**
 * HTTP implementation of {@link GetDocument}, on OpenSearch's REST API.
 *
 * @layer
 * @provides Stackit.OpenSearch.GetDocument
 */
export const GetDocumentHttp = Layer.succeed(
  GetDocument,
  makeIndexBinding((call) => (request: GetDocumentRequest) => call(data.getDocument, request)),
);
