import * as Axiom from "@alchemy.run/axiom";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Axiom.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Deterministic names (no Date.now) so reruns target the same view/dataset and
// the start/end destroy bookends keep the org clean. A view's APL query is
// validated against existing datasets on create, so we stand up a backing
// dataset in the same stack.
const VIEW_NAME = "alchemy-list-test-view";
const DATASET_NAME = "alchemy-list-test-view-dataset";

test.provider(
  "list enumerates the deployed view",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* Axiom.Dataset("ListViewDataset", {
            name: DATASET_NAME,
          });
          return yield* Axiom.View("ListView", {
            name: VIEW_NAME,
            description: "alchemy list() lifecycle op test",
            datasets: [dataset.name],
            aplQuery: `['${DATASET_NAME}'] | take 1`,
          });
        }),
      );
      yield* expectFound(Axiom.View.lookup({ id: deployed.id }), deployed);

      const provider = yield* Provider.findProvider(Axiom.View);
      const all = yield* provider.list();

      // `getViews` returns the full account-wide list in one shot; the freshly
      // created view must be present, hydrated into the exact `read` Attributes
      // shape (so `.id` / `.name` are directly usable by `delete`).
      expect(all.some((v) => v.id === deployed.id)).toBe(true);

      const row = all.find((v) => v.id === deployed.id)!;
      expect(row.name).toEqual(VIEW_NAME);
      expect(row.aplQuery).toEqual(deployed.aplQuery);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:axiom", "provider:axiom:dataset", "provider:axiom:view", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "a view without state is adopted by name only with adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // Views are named per stage so concurrent users never share one.
      const viewName = `alchemy-adopt-view-${stack.stage}`;
      const datasetName = `alchemy-adopt-view-dataset-${stack.stage}`;
      const program = (description: string, adoptIt?: boolean) =>
        Effect.gen(function* () {
          const dataset = yield* Axiom.Dataset("AdoptViewDataset", { name: datasetName });
          const view = Axiom.View("AdoptView", {
            name: viewName,
            description,
            datasets: [dataset.name],
            aplQuery: `['${datasetName}'] | take 1`,
          });
          return yield* adoptIt === undefined ? view : view.pipe(adopt(adoptIt));
        });

      const initial = yield* stack.deploy(program("first"));

      // Wipe the view's state; the view stays in Axiom.
      yield* Effect.gen(function* () {
        const state = yield* yield* State;
        yield* state.delete({ stack: stack.name, stage: stack.stage, fqn: "AdoptView" });
      }).pipe(Effect.provide(stack.state));

      // Views carry no ownership marker, so one found by name is foreign.
      const refused = yield* stack.deploy(program("second")).pipe(Effect.flip);
      expect(refused).toMatchObject({ _tag: "OwnedBySomeoneElse", logicalId: "AdoptView" });

      const adopted = yield* stack.deploy(program("second", true));
      expect(adopted.id).toEqual(initial.id);

      const provider = yield* Provider.findProvider(Axiom.View);
      const views = (yield* provider.list()).filter((v) => v.name === viewName);
      expect(views).toHaveLength(1);
      expect(views[0]!.description).toEqual("second");

      yield* stack.destroy();
      const after = yield* provider.list();
      expect(after.some((v) => v.name === viewName)).toBe(false);
    }).pipe(logLevel),
  {
    tags: ["provider:axiom", "provider:axiom:dataset", "provider:axiom:view", "live"],
    timeout: 180_000,
  },
);
