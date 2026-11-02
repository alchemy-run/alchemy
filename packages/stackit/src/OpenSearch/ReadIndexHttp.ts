import * as Layer from "effect/Layer";
import { makeIndexBinding, makeReadIndexClient } from "./BindingHttp.ts";
import { ReadIndex } from "./ReadIndex.ts";

/**
 * HTTP implementation of {@link ReadIndex}, on OpenSearch's REST API.
 *
 * @layer
 * @provides Stackit.OpenSearch.ReadIndex
 */
export const ReadIndexHttp = Layer.succeed(ReadIndex, makeIndexBinding(makeReadIndexClient));
