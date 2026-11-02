import * as Layer from "effect/Layer";
import { indexDocument, makeIndexBinding } from "./BindingHttp.ts";
import { IndexDocument, type IndexDocumentRequest } from "./IndexDocument.ts";

/**
 * HTTP implementation of {@link IndexDocument}, on OpenSearch's REST API.
 *
 * @layer
 * @provides Stackit.OpenSearch.IndexDocument
 */
export const IndexDocumentHttp = Layer.succeed(
  IndexDocument,
  makeIndexBinding((call) => (request: IndexDocumentRequest) => indexDocument(call, request)),
);
