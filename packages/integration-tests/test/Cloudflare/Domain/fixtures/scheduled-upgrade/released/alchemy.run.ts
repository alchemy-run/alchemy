import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import FeedsWorker from "./worker.ts";

export default Alchemy.Stack(
  "DomainScheduledUpgrade",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* FeedsWorker;
    return { url: worker.url };
  }),
);
