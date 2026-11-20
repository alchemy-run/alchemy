import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import DomainConformanceWorker from "./conformance-worker.ts";
import DomainLatencyFarWorker from "./latency-far-worker.ts";

const options = {
  providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
  state: Cloudflare.state(),
};

// A stack each: two Workers hosting one model would share its backfill.

/** The model with its Durable Objects created near the caller. */
export const Near = Alchemy.Stack(
  "DomainLatencyNearStack",
  options,
  Effect.gen(function* () {
    const worker = yield* DomainConformanceWorker;
    return { url: worker.url.as<string>() };
  }),
);

/** The model with its Durable Objects created in Asia-Pacific. */
export const Far = Alchemy.Stack(
  "DomainLatencyFarStack",
  options,
  Effect.gen(function* () {
    const worker = yield* DomainLatencyFarWorker;
    return { url: worker.url.as<string>() };
  }),
);
