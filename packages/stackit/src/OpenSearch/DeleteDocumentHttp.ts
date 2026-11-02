import * as data from "@distilled.cloud/stackit/opensearch_data";
import * as Layer from "effect/Layer";
import { makeIndexBinding } from "./BindingHttp.ts";
import { DeleteDocument, type DeleteDocumentRequest } from "./DeleteDocument.ts";

/**
 * HTTP implementation of {@link DeleteDocument}, on OpenSearch's REST API.
 *
 * @layer
 * @provides Stackit.OpenSearch.DeleteDocument
 */
export const DeleteDocumentHttp = Layer.succeed(
  DeleteDocument,
  makeIndexBinding(
    (call) => (request: DeleteDocumentRequest) => call(data.deleteDocument, request),
  ),
);
