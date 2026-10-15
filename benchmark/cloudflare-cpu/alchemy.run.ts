import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import CpuWorker from "./src/worker.ts";

// Pass an explicit experiment stage to the CLI. Keep the same stage and state
// directory for baseline and candidate so they update the same Worker.
export default Alchemy.Stack(
  "CloudflareCpuBenchmark",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* CpuWorker;
    return {
      workerUrl: worker.url.as<string>(),
      workerName: worker.workerName,
      workerId: worker.workerId,
    };
  }),
);
