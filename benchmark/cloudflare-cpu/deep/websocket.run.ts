import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Worker from "./websocket-worker.ts";

export default Alchemy.Stack(
  "CloudflareDeepWebSocketBenchmark",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return {
      url: worker.url.as<string>(),
      workerName: worker.workerName,
      workerId: worker.workerId,
      uploadedVersion: worker.versionId,
      namespaces: worker.durableObjectNamespaces,
      durableObjectClass: "DeepWebSocketObject",
    };
  }),
);
