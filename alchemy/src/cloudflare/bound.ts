import type { Pipeline } from "cloudflare:pipelines";
import type { Secret } from "../secret.js";
import type { AiGateway as _AiGateway } from "./ai-gateway.js";
import type { Assets } from "./assets.js";
import type { Binding } from "./bindings.js";
import type { R2Bucket as _R2Bucket } from "./bucket.js";
import type { D1Database as _D1Database } from "./d1-database.js";
import type { DurableObjectNamespace as _DurableObjectNamespace } from "./durable-object-namespace.js";
import type { Hyperdrive as _Hyperdrive } from "./hyperdrive.js";
import type { KVNamespace as _KVNamespace } from "./kv-namespace.js";
import type { Pipeline as _Pipeline } from "./pipeline.js";
import type { Queue as _Queue } from "./queue.js";
import type { VectorizeIndex as _VectorizeIndex } from "./vectorize-index.js";
import type { Worker as _Worker } from "./worker.js";
import type { Workflow as _Workflow } from "./workflow.js";

export type Bound<T extends Binding> = T extends _DurableObjectNamespace
  ? DurableObjectNamespace
  : T extends _KVNamespace
    ? KVNamespace
    : T extends _Worker
      ? Worker
      : T extends _R2Bucket
        ? R2Bucket
        : T extends _AiGateway
          ? AiGateway
          : T extends _Hyperdrive
            ? Hyperdrive
            : T extends Secret
              ? string
              : T extends Assets
                ? Service
                : T extends _Workflow<infer P>
                  ? Workflow<P>
                  : T extends _D1Database
                    ? D1Database
                    : T extends _VectorizeIndex
                      ? VectorizeIndex
                      : T extends _Queue<infer Body>
                        ? Queue<Body>
                        : T extends _Pipeline<infer R>
                          ? Pipeline<R>
                          : T extends string
                            ? string
                            : Service;
