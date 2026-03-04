import * as Effect from "effect/Effect";
import type { ExecutionContext } from "../../Host.ts";
import { isWorker } from "../Workers/Worker.ts";
import type { Namespace } from "./Namespace.ts";

export const NamespaceBinding = Effect.fn(function* (
  worker: ExecutionContext["Service"],
  namespace: Namespace,
) {
  if (isWorker(worker)) {
    yield* worker.bind`Bind(${namespace})`({
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
      new Error(`NamespaceBinding does not support runtime '${worker.Type}'`),
    );
  }
});
