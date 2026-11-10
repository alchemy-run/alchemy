import * as Axiom from "@alchemy.run/axiom";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Axiom.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Deterministic dataset name so re-runs reuse (and reconcile) the same dataset
// rather than piling up duplicates.
const DATASET_NAME = "alchemy-test-annotation-list";

test.provider(
  "list enumerates the deployed annotation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* Axiom.Dataset("ListDataset", {
            name: DATASET_NAME,
          });
          return yield* Axiom.Annotation("ListAnnotation", {
            type: "deploy",
            title: "list() coverage marker",
            datasets: [dataset.name],
            time: "2026-01-01T00:00:00Z",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Axiom.Annotation);
      const all = yield* provider.list();

      // `getAnnotations` returns the full account-wide list in one shot; the
      // freshly created annotation must be present, hydrated into the exact
      // `read` shape (so `.id` / `.type` are directly usable by `delete`).
      const found = all.find((a) => a.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.type).toEqual("deploy");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:axiom", "provider:axiom:annotation", "provider:axiom:dataset", "live"],
    timeout: 120_000,
  },
);
