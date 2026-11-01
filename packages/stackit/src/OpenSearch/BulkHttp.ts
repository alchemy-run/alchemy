import * as Layer from "effect/Layer";
import { bulk, makeIndexBinding } from "./BindingHttp.ts";
import { Bulk, type BulkRequest } from "./Bulk.ts";

/**
 * HTTP implementation of {@link Bulk}, on OpenSearch's REST API.
 *
 * @layer
 * @provides Stackit.OpenSearch.Bulk
 */
export const BulkHttp = Layer.succeed(
  Bulk,
  makeIndexBinding((call) => (request: BulkRequest) => bulk(call, request)),
);
