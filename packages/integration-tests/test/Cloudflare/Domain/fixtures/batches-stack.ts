import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import DomainBatchesWorker from "./batches-worker.ts";

export default (state = Cloudflare.state()) =>
  Alchemy.Stack(
    "DomainBatchesStack",
    { providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()), state },
    Effect.gen(function* () {
      const worker = yield* DomainBatchesWorker;
      return { url: worker.url.as<string>() };
    }),
  );
