import * as Layer from "effect/Layer";
import { makeIndexBinding, makeReadWriteIndexClient } from "./BindingHttp.ts";
import { ReadWriteIndex } from "./ReadWriteIndex.ts";

/**
 * HTTP implementation of {@link ReadWriteIndex}, on OpenSearch's REST API.
 *
 * @layer
 * @provides Stackit.OpenSearch.ReadWriteIndex
 */
export const ReadWriteIndexHttp = Layer.succeed(
  ReadWriteIndex,
  makeIndexBinding(makeReadWriteIndexClient),
);
