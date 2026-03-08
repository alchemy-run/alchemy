import * as Effect from "effect/Effect";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker } from "../Workers/Worker.ts";
import type { Namespace } from "./Namespace.ts";

export const NamespaceBinding = Effect.fn(function* (
  host: ResourceLike,
  namespace: Namespace,
) {
  if (isWorker(host)) {
    yield* host.bind`Bind(${namespace})`({
      bindings: [
        {
          type: "kv_namespace",
          name: namespace.LogicalId,
          namespace_id: namespace.namespaceId,
        },
      ],
    });
  } else {
    return yield* Effect.die(
      new Error(`NamespaceBinding does not support runtime '${host.Type}'`),
    );
  }
});
