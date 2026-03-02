import * as Effect from "effect/Effect";
import * as Worker from "../Workers/Worker.ts";
import type { Namespace } from "./Namespace.ts";

export const NamespaceBinding = Effect.gen(function* () {
  const worker = yield* Worker.WorkerRuntime;
  return (namespace: Namespace) =>
    worker.bind({
      bindings: [
        {
          type: "kv_namespace",
          name: namespace.LogicalId,
          namespace_id: namespace.namespaceId,
        },
      ],
    });
});
