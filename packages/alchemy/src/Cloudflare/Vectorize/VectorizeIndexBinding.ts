import * as Effect from "effect/Effect";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker } from "../Workers/Worker.ts";
import type { VectorizeIndex } from "./VectorizeIndex.ts";

export const IndexBinding = Effect.fn(function* (
  host: ResourceLike,
  index: VectorizeIndex,
) {
  if (isWorker(host)) {
    yield* host.bind`${index}`({
      bindings: [
        {
          type: "vectorize",
          name: index.LogicalId,
          indexName: index.indexName,
        },
      ],
    });
  } else {
    return yield* Effect.die(
      new Error(`IndexBinding does not support runtime '${host.Type}'`),
    );
  }
});
