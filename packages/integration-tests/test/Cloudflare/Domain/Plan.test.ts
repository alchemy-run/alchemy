import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Worker from "./fixtures/unrestricted-worker.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
});

describe(
  "a model in a plan",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    test.provider(
      "a model owns every binding it declares, and a policy is listed under its own",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const plan = yield* stack.plan(
            Effect.gen(function* () {
              return { worker: yield* Worker };
            }),
          );
          const terms = plan.resources["DomainCounterWorker"]?.capabilities ?? [];
          const model = terms.find((term) => term.id === "Model:Counters");
          // Its class, its backfill, and each piece's old classes and their retirement.
          expect(model?.resources).toEqual(
            expect.arrayContaining([
              "Counters.Domain",
              "Counters.DomainBackfill",
              "Counters.CounterAggregate",
              "Counters.CounterAggregate.BeforeVersions",
              "Counters.CounterAggregate.Retiring",
              "Counters.StartMirrorPolicy",
              "Counters.StartMirrorPolicy.Retiring",
            ]),
          );
          // Every binding named for the model is the model's.
          const named = (plan.resources["DomainCounterWorker"]?.bindings ?? [])
            .map((binding) => binding.sid)
            .filter((sid) => sid.startsWith("Counters."));
          expect(named.filter((sid) => !model?.resources?.includes(sid))).toEqual([]);
          expect(terms.find((term) => term.id === "Policy:StartMirror")?.host).toBe(
            "Counters.StartMirrorPolicy",
          );
          yield* stack.destroy();
        }),
      { timeout: 180_000 },
    );
  },
);
