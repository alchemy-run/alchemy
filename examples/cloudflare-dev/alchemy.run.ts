import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type {
  Counter as CounterClass,
  QueueStorage as QueueStorageClass,
} from "./src/AsyncWorker.ts";
import EffectWorker from "./src/EffectWorker.ts";

export const Counter = Cloudflare.DurableObjectNamespace<CounterClass>(
  "Counter",
  {
    className: "Counter",
  },
);

export const QueueStorage =
  Cloudflare.DurableObjectNamespace<QueueStorageClass>("QueueStorage", {
    className: "QueueStorage",
  });

export type AsyncWorkerEnv = Cloudflare.InferEnv<
  ReturnType<typeof makeAsyncWorker>
>;

const MyQueue = Cloudflare.Queue("MyQueue");

const makeAsyncWorker = (id: string) =>
  Cloudflare.Worker(id, {
    main: "./src/AsyncWorker.ts",
    env: {
      COUNTER: Counter,
      QUEUE_STORAGE: QueueStorage,
      MY_VARIABLE: "my-variable-abc123",
      MY_SECRET: Config.redacted("MY_SECRET").pipe(
        Config.withDefault(Redacted.make("my-secret-abc123")),
      ),
      MY_QUEUE: MyQueue,
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

    const queue = yield* MyQueue;
    yield* Cloudflare.QueueConsumer("QueueConsumer", {
      queueId: queue.queueId,
      scriptName: asyncWorker.workerName,
      settings: {
        batchSize: 10,
        maxRetries: 3,
        maxWaitTimeMs: 5000,
      },
    });

    // Spawn several additional workers to test concurrency.
    const additionalWorkers = yield* Effect.forEach(
      Array.from({ length: 5 }),
      (_, i) => makeAsyncWorker(`AdditionalWorker${i + 1}`),
    );

    return {
      asyncWorker: asyncWorker.url,
      effectWorker: effectWorker.url,
      additionalWorkers: additionalWorkers.map((w) => w.url),
    };
  }),
);
