import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Counter as CounterClass } from "./src/AsyncWorker.ts";
import EffectWorker from "./src/EffectWorker.ts";

export const Counter = Cloudflare.DurableObjectNamespace<CounterClass>(
  "Counter",
  {
    className: "Counter",
  },
);

export type AsyncWorkerEnv = Cloudflare.InferEnv<
  ReturnType<typeof makeAsyncWorker>
>;

const makeAsyncWorker = (id: string) =>
  Cloudflare.Worker(id, {
    main: "./src/AsyncWorker.ts",
    env: {
      COUNTER: Counter,
      MY_VARIABLE: "my-variable-abc123",
      MY_SECRET: Config.redacted("MY_SECRET").pipe(
        Config.withDefault(Redacted.make("my-secret-abc123")),
      ),
    },
  });

export default Alchemy.Stack(
  "CloudflareDev",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const asyncWorker = yield* makeAsyncWorker("AsyncWorker");
    const effectWorker = yield* EffectWorker;

    // Spawn several additional workers to test concurrency.
    // TODO: Effect.all doesn't work here; Platform needs to be updated to use Effectable.
    const additionalWorkers = [
      yield* makeAsyncWorker("AdditionalWorker1"),
      yield* makeAsyncWorker("AdditionalWorker2"),
      yield* makeAsyncWorker("AdditionalWorker3"),
      yield* makeAsyncWorker("AdditionalWorker4"),
      yield* makeAsyncWorker("AdditionalWorker5"),
    ];

    return {
      asyncWorker: asyncWorker.url,
      effectWorker: effectWorker.url,
      additionalWorkers: additionalWorkers.map((worker) => worker.url),
    };
  }),
);
