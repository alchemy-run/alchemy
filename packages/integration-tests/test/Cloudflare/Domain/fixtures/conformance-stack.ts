import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import DomainConformanceWorker from "./conformance-worker.ts";

export default Alchemy.Stack(
  "DomainConformanceStack",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* DomainConformanceWorker;
    return { url: worker.url.as<string>() };
  }),
);
