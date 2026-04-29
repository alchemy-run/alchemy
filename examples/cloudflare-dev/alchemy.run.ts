import * as Cloudflare from "alchemy/Cloudflare";
import * as Alchemy from "alchemy/Stack";
import * as Effect from "effect/Effect";
import type { Counter as CounterClass } from "./src/AsyncWorker.ts";
import EffectWorker from "./src/EffectWorker.ts";

export const Counter = Cloudflare.DurableObjectNamespace<CounterClass>(
  "Counter",
  {
    className: "Counter",
  },
);

export type AsyncWorkerEnv = Cloudflare.InferEnv<typeof AsyncWorker>;

export const AsyncWorker = Cloudflare.Worker("AsyncWorker", {
  main: "./src/AsyncWorker.ts",
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
    const asyncWorker = yield* AsyncWorker;
    const effectWorker = yield* EffectWorker;

    return {
      asyncWorker: asyncWorker.url,
      effectWorker: effectWorker.url,
    };
  }),
);
