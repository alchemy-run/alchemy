import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";

export const EventsStream = Cloudflare.Pipelines.Stream("BindingStream", {});

export const AsyncWorker = Cloudflare.Worker("PipelinesAsyncWorker", {
  main: pathe.resolve(import.meta.dirname, "async-worker.ts"),
  env: {
    EVENTS: EventsStream,
  },
});

export type AsyncWorkerEnv = Cloudflare.InferEnv<typeof AsyncWorker>;

export default Alchemy.Stack(
  "PipelinesBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stream = yield* EventsStream;
    const worker = yield* AsyncWorker;

    return {
      url: worker.url.as<string>(),
      workerName: worker.workerName.as<string>(),
      streamId: stream.streamId.as<string>(),
    };
  }),
);
