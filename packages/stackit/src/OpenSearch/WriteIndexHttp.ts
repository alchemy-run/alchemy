import * as Layer from "effect/Layer";
import { makeIndexBinding, makeWriteIndexClient } from "./BindingHttp.ts";
import { WriteIndex } from "./WriteIndex.ts";

/**
 * HTTP implementation of {@link WriteIndex}, on OpenSearch's REST API.
 *
 * @layer
 * @provides Stackit.OpenSearch.WriteIndex
 */
export const WriteIndexHttp = Layer.succeed(WriteIndex, makeIndexBinding(makeWriteIndexClient));
