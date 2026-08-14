import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import FinalizerLatencyWorker from "./worker.ts";

export default Alchemy.Stack(
  "FinalizerLatencyStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* FinalizerLatencyWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
