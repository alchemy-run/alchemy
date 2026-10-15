import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import TracedDispatchWorker from "./src/dispatch-traced-worker.ts";
import PlainDispatchWorker from "./src/dispatch-worker.ts";

export default Alchemy.Stack(
  "CloudflareDispatchBenchmark",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const plain = yield* PlainDispatchWorker;
    const traced = yield* TracedDispatchWorker;
    return {
      plainUrl: plain.url.as<string>(),
      plainWorkerName: plain.workerName,
      plainWorkerId: plain.workerId,
      plainNamespaces: plain.durableObjectNamespaces,
      tracedUrl: traced.url.as<string>(),
      tracedWorkerName: traced.workerName,
      tracedWorkerId: traced.workerId,
      tracedNamespaces: traced.durableObjectNamespaces,
    };
  }),
);
