import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import DomainToursWorker from "./tours-worker.ts";

export default Alchemy.Stack(
  "DomainViewKeyStack",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* DomainToursWorker;
    return { url: worker.url.as<string>() };
  }),
);
