import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import DnsEffectWorker from "./effect.ts";

export default Alchemy.Stack(
  "DnsTestStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const effectWorker = yield* DnsEffectWorker;
    return {
      effectUrl: effectWorker.url.as<string>(),
    };
  }),
);
