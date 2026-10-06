import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import DurableObjectWorkerEnvironmentWorker from "./worker.ts";

export default Alchemy.Stack(
  "DurableObjectWorkerEnvironmentStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* DurableObjectWorkerEnvironmentWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
