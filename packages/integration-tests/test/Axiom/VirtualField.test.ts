import * as Axiom from "@alchemy.run/axiom";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Axiom.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Deterministic names (no Date.now) so reruns reconcile the same dataset and
// virtual field rather than piling up duplicates.
const DATASET_NAME = "alchemy-test-virtualfield-list";
const FIELD_NAME = "alchemy_list_status_class";

test.provider(
  "list enumerates the deployed virtual field",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* Axiom.Dataset("ListDataset", {
            name: DATASET_NAME,
          });
          return yield* Axiom.VirtualField("ListVirtualField", {
            dataset: dataset.name,
            name: FIELD_NAME,
            description: "list() coverage marker",
            expression: 'strcat(tostring(toint(status / 100)), "xx")',
            type: "string",
          });
        }),
      );
      yield* expectFound(Axiom.VirtualField.lookup({ id: deployed.id }), deployed);

      const provider = yield* Provider.findProvider(Axiom.VirtualField);
      const all = yield* provider.list();

      // `getVirtualFields` is per-dataset, so `list()` enumerates every dataset
      // and fans out the per-dataset vfields list; the freshly created field
      // must be present, hydrated into the exact `read` shape (so `.id` /
      // `.dataset` are directly usable by `delete`).
      const found = all.find((vf) => vf.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(FIELD_NAME);
      expect(found?.dataset).toEqual(DATASET_NAME);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:axiom", "provider:axiom:dataset", "provider:axiom:virtualfield", "live"],
    timeout: 120_000,
  },
);
