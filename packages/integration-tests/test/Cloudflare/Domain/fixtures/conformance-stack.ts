import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import DomainConformanceWorker from "./conformance-worker.ts";

export default Alchemy.Stack(
  "DomainConformanceStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* DomainConformanceWorker;
    return { url: worker.url.as<string>() };
  }),
);
