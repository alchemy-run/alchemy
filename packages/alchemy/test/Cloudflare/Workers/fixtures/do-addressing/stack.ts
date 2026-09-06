import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import Worker from "./worker.ts";

export default Alchemy.Stack(
  "DurableObjectAddressingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return {
      url: worker.url.as<string>(),
    };
  }),
);
