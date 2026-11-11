import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import { roundTrip } from "./fixtures/counter-client.ts";
import DomainPlacedCounterWorker from "./fixtures/wnam-worker.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/**
 * `DomainCloudflare.layerDurableObjects({ locationHint: "wnam" })` passes the
 * hint to every namespace the model reaches: its aggregates, its view, its
 * policy and the workflow engine's saga executions are all created with it.
 */
test.provider(
  "a Domain model's Durable Objects are created with its location hint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* DomainPlacedCounterWorker };
        }),
      );
      yield* roundTrip(worker.url!);
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000, tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
);
