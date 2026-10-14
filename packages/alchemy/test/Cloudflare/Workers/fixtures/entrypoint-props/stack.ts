import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import EntrypointPropsWorker from "./worker.ts";

export default Alchemy.Stack(
  "EntrypointPropsStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* EntrypointPropsWorker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
