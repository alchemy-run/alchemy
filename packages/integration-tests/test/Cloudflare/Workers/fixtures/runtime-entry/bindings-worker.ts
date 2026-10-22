import { Namespace } from "@alchemy.run/cloudflare/KV/Namespace";
import { Queue } from "@alchemy.run/cloudflare/Queues/Queue";
import { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// Async bindings route through WorkerAsyncBindings, which imports the `is*`
// guards from the resource modules that also hold the providers (#2371).
export default class BindingsWorker extends Worker<BindingsWorker>()(
  "BindingsWorker",
  {
    main: import.meta.url,
    bindings: { KV: Namespace("RuntimeEntryKV"), QUEUE: Queue("RuntimeEntryQueue") },
  },
  Effect.gen(function* () {
    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }),
) {}
