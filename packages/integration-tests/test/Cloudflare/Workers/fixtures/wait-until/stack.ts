import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import WaitUntilWorker from "./wait-until-worker.ts";

/** The fixture Worker, and a producer whose traces reach its `tail` handler. */
export const WaitUntilResources = Effect.gen(function* () {
  const worker = yield* WaitUntilWorker;
  const producer = yield* Cloudflare.Worker("WaitUntilTailProducer", {
    main: pathe.resolve(import.meta.dirname, "tail-producer.ts"),
    tailConsumers: [worker],
  });
  return {
    url: worker.url.as<string>(),
    producerUrl: producer.url.as<string>(),
  };
});

export default Alchemy.Stack(
  "WaitUntilStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  WaitUntilResources,
);
