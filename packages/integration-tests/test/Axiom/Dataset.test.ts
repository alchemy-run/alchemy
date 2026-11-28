import * as Axiom from "@alchemy.run/axiom";
import * as AxiomCredentials from "@alchemy.run/axiom/Credentials";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as AxiomApi from "@distilled.cloud/axiom";
import * as AxiomPreview from "@distilled.cloud/axiom/unstable/v2";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import { expectFound } from "./lookup.ts";

// The profile's token, unless a test swaps in another one for a while.
// Safe because tests in a file run one at a time.
const swapped: { token?: Redacted.Redacted<string> } = {};

// Every provider uses these credentials: the profile's token, or the
// swapped one.
const credentials = Layer.effect(
  AxiomCredentials.Credentials,
  Effect.gen(function* () {
    const profile = yield* AxiomCredentials.Credentials;
    return Effect.suspend(() => {
      const token = swapped.token;
      return token ? Effect.map(profile, (c) => ({ ...c, apiKey: token })) : profile;
    });
  }),
).pipe(Layer.provide(Axiom.providers()));

const { test } = Test.make({ providers: Axiom.providers().pipe(Layer.provide(credentials)) });

// Run `effect` as a token with org capabilities only: it may create,
// update and delete datasets, but every `GET /v2/datasets/:id` is 403.
const asOrgOnlyToken = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    AxiomApi.createAPIToken({
      name,
      orgCapabilities: { datasets: ["create", "read", "update", "delete"] },
    }),
    (token) =>
      Effect.suspend(() => {
        const value = token.token ?? "";
        swapped.token = Redacted.isRedacted(value) ? value : Redacted.make(value);
        // The swap took: the provider now can't read datasets.
        return AxiomPreview.getDataset({ dataset_id: "alchemy-test-probe" }).pipe(
          Effect.flip,
          Effect.flatMap((error) => {
            expect(error._tag).toBe("Forbidden");
            return effect;
          }),
        );
      }).pipe(Effect.ensuring(Effect.sync(() => delete swapped.token))),
    (token) => AxiomApi.deleteAPIToken({ id: token.id }).pipe(Effect.ignore),
  );

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

// #3806: a token with org capabilities only can't read datasets.
test.provider(
  "deploys with a token that can't read datasets",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = `alchemy-test-blind-${stack.stage}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

      const deployed = yield* asOrgOnlyToken(
        `alchemy-test-blind-${stack.stage}`,
        Effect.gen(function* () {
          const created = yield* stack.deploy(
            Axiom.Dataset("BlindDataset", { name, description: "first" }),
          );
          const updated = yield* stack.deploy(
            Axiom.Dataset("BlindDataset", { name, description: "second", retentionDays: 7 }),
          );
          expect(updated.id).toEqual(created.id);
          return updated;
        }),
      );

      const observed = yield* AxiomPreview.getDataset({ dataset_id: deployed.id });
      expect(observed.description.startsWith("second\n[alchemy:")).toBe(true);
      expect(observed.retentionDays).toEqual(7);

      yield* asOrgOnlyToken(`alchemy-test-blind-${stack.stage}`, stack.destroy());
      const gone = yield* AxiomPreview.getDataset({ dataset_id: deployed.id }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  {
    tags: ["provider:axiom", "provider:axiom:dataset", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "won't take over a dataset it can't read",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = `alchemy-test-foreign-${stack.stage}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

      yield* Effect.acquireUseRelease(
        AxiomPreview.createDataset({ name, description: "not alchemy's" }),
        () =>
          Effect.gen(function* () {
            yield* asOrgOnlyToken(
              `alchemy-test-foreign-${stack.stage}`,
              Effect.gen(function* () {
                const error = yield* stack
                  .deploy(Axiom.Dataset("ForeignDataset", { name }))
                  .pipe(Effect.flip);
                expect(error).toMatchObject({
                  _tag: "DatasetNotReadable",
                  dataset: name,
                  exists: true,
                });
                // The failed create must not leave anything destroy would delete.
                yield* stack.destroy();
              }),
            );

            const observed = yield* AxiomPreview.getDataset({ dataset_id: name });
            expect(observed.description).toEqual("not alchemy's");
          }),
        () => AxiomPreview.deleteDataset({ dataset_id: name }).pipe(Effect.ignore),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:axiom", "provider:axiom:dataset", "live"],
    timeout: 120_000,
  },
);
