import * as Cloudflare from "alchemy/Cloudflare";
import * as Alchemy from "alchemy/Stack";
import * as Effect from "effect/Effect";
import type { Counter as CounterClass } from "./src/HelloWorld.ts";

export const Counter = Cloudflare.DurableObjectNamespace<CounterClass>(
  "Counter",
  {
    className: "Counter",
  },
);

export type HelloWorldEnv = Cloudflare.InferEnv<typeof HelloWorld>;

export const HelloWorld = Cloudflare.Worker("HelloWorld", {
  main: "./src/HelloWorld.ts",
  bindings: {
    Counter,
  },
});

export default Alchemy.Stack(
  "CloudflareDev",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* HelloWorld;

    // Register the same worker script as a consumer of Queue. The worker's
    // `queue(batch)` handler (see src/worker.ts) receives each message batch.
    // yield* Cloudflare.QueueConsumer("QueueConsumer", {
    //   queueId: queue.queueId,
    //   scriptName: worker.workerName,
    //   settings: {
    //     batchSize: 10,
    //     maxRetries: 3,
    //     maxWaitTimeMs: 5000,
    //   },
    // });

    return worker.url;
  }),
);
