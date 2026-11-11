import * as Axiom from "@alchemy.run/axiom";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Axiom.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Deterministic dataset name so re-runs reconcile the same dataset rather than
// piling up duplicates (no Date.now in physical names).
const DATASET_NAME = "alchemy-test-dataset-list";

// Canonical `list()` test (account collection): Axiom exposes a single
// org-wide `GET /v2/datasets` op, so `list()` enumerates every dataset and
// hydrates each row into the exact `read` Attributes shape.
test.provider(
  "list enumerates the deployed dataset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Axiom.Dataset("ListDataset", {
            name: DATASET_NAME,
            description: "alchemy list() lifecycle op test",
          });
        }),
      );
      yield* expectFound(Axiom.Dataset.lookup({ name: deployed.name }), deployed);

      const provider = yield* Provider.findProvider(Axiom.Dataset);
      const all = yield* provider.list();

      // `getDatasets` returns the full account-wide list in one shot; the
      // freshly created dataset must be present, hydrated into the exact
      // `read` shape (so `.id` / `.name` are directly usable by `delete`).
      const found = all.find((d) => d.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(DATASET_NAME);
      expect(found?.kind).toEqual(deployed.kind);
      expect(found?.edgeDeployment).toEqual(deployed.edgeDeployment);
      expect(found?.edgeDeploymentUrl).toEqual(deployed.edgeDeploymentUrl);
      expect(found?.otelEndpoint).toEqual(deployed.edgeDeploymentUrl.replace(/\/$/, ""));
      expect(found?.otelTracesEndpoint).toEqual(deployed.otelTracesEndpoint);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:axiom", "provider:axiom:dataset", "live"],
    timeout: 120_000,
  },
);
