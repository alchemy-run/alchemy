import type { Binding } from "./bindings";
import type { DurableObjectNamespace as _DurableObjectNamespace } from "./durable-object-namespace";
import type { KVNamespace as _KVNamespace } from "./kv-namespace";
import type { Worker as _Worker } from "./worker";

export type Bound<T extends Binding> = T extends _DurableObjectNamespace
  ? DurableObjectNamespace
  : T extends _KVNamespace
    ? KVNamespace
    : T extends _Worker
      ? Worker
      : never;
