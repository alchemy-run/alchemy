import type { Secret } from "../secret";
import type { Binding } from "./bindings";
import type { R2Bucket as _R2Bucket } from "./bucket";
import type { DurableObjectNamespace as _DurableObjectNamespace } from "./durable-object-namespace";
import type { KVNamespace as _KVNamespace } from "./kv-namespace";
import type { Worker as _Worker } from "./worker";

export type Bound<T extends Binding> = T extends _DurableObjectNamespace
  ? DurableObjectNamespace
  : T extends _KVNamespace
    ? KVNamespace
    : T extends _Worker
      ? Worker
      : T extends _R2Bucket
        ? R2Bucket
        : T extends Secret
          ? string
          : never;
