import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import LogTestWorker from "./worker.ts";

export default Alchemy.Stack(
  "TestLoggerStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* LogTestWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
