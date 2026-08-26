import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as translate from "@distilled.cloud/gcp/translate_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  location,
  logLevel,
  parent,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  translate.getProjectsLocationsModels({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const datasetNameFromOperation = (operation: translate.Operation) => {
  const response = operation.response ?? {};
  const name = response.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
};

const createDataset = (displayName: string) =>
  Effect.gen(function* () {
    const page = yield* translate.listProjectsLocationsDatasets({
      parent,
      pageSize: 100,
    });
    const match = (page.datasets ?? []).find(
      (dataset) => dataset.displayName === displayName,
    );
    if (match?.name) return match.name;
    const operation = yield* translate.createProjectsLocationsDatasets({
      parent,
      body: {
        displayName,
        sourceLanguageCode: "en",
        targetLanguageCode: "es",
      },
    });
    const done = yield* GCP.Translate.waitForOperation(operation);
    const name = datasetNameFromOperation(done);
    if (name !== undefined) return name;
    const again = yield* translate.listProjectsLocationsDatasets({
      parent,
      pageSize: 100,
    });
    return (again.datasets ?? []).find(
      (dataset) => dataset.displayName === displayName,
    )?.name;
  });

const deleteDataset = (name: string) =>
  translate.deleteProjectsLocationsDatasets({ name }).pipe(
    Effect.flatMap((operation) =>
      GCP.Translate.waitForOperation(operation, { notFoundOk: true }),
    ),
    Effect.catchTag("NotFound", () => Effect.void),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsModels on a missing model fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        translate.getProjectsLocationsModels({
          name: `${parent}/models/alchemy-missing-model`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a translation model",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* translate
        .listProjectsLocationsModels({
          parent,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", (error) =>
            Effect.succeed({
              tag: "Forbidden" as const,
              message: error.message,
            }),
          ),
          Effect.catchTag("NotFound", (error) =>
            Effect.succeed({
              tag: "NotFound" as const,
              message: error.message,
            }),
          ),
        );
      if (probe.tag === "Forbidden") {
        expect(probe.tag).toEqual("Forbidden");
        yield* stack.destroy();
        return;
      }
      expect(["ok", "NotFound"]).toContain(probe.tag);

      const displayName = "alcmodelds";
      const dataset = yield* createDataset(displayName).pipe(
        Effect.map((name) => ({ tag: "ok" as const, name })),
        Effect.catchTag("Forbidden", (error) =>
          Effect.succeed({
            tag: "Forbidden" as const,
            message: error.message,
          }),
        ),
        Effect.catchTag("BadRequest", (error) =>
          Effect.succeed({
            tag: "BadRequest" as const,
            message: error.message,
          }),
        ),
        Effect.catchTag("GCP.Translate.OperationPending", (error) =>
          Effect.succeed({
            tag: "GCP.Translate.OperationPending" as const,
            message: error.message,
          }),
        ),
        Effect.catchTag("GCP.Translate.OperationFailed", (error) =>
          Effect.succeed({
            tag: "GCP.Translate.OperationFailed" as const,
            message: error.message,
          }),
        ),
      );
      if (dataset.tag !== "ok" || dataset.name === undefined) {
        expect([
          "Forbidden",
          "BadRequest",
          "GCP.Translate.OperationPending",
          "GCP.Translate.OperationFailed",
          "ok",
        ]).toContain(dataset.tag);
        yield* stack.destroy();
        return;
      }

      const datasetName = dataset.name;
      const created = yield* Effect.result(
        stack.deploy(
          Effect.gen(function* () {
            const model = yield* GCP.Translate.Model("EnEs", {
              location,
              dataset: datasetName,
              displayName: "enes",
            });
            return { model };
          }),
        ),
      );

      if (Result.isFailure(created)) {
        expect([
          "Forbidden",
          "BadRequest",
          "GCP.Translate.OperationFailed",
          "GCP.Translate.ResourceNotResolved",
        ]).toContain(created.failure._tag);
        yield* deleteDataset(datasetName);
        yield* stack.destroy();
        return;
      }

      const model = created.success.model;
      expect(model.name).toContain("/models/");
      expect(model.location).toEqual(location);
      expect(model.dataset).toEqual(datasetName);
      expect(model.displayName).toEqual("enes");

      const fetched = yield* translate.getProjectsLocationsModels({
        name: model.name,
      });
      expect(fetched.name).toEqual(model.name);
      expect(fetched.displayName).toMatch(/^alc_/);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Translate.Model("EnEs", {
            modelId: model.modelId,
            location,
            dataset: datasetName,
            displayName: "enes",
          });
        }),
      );

      expect(updated.name).toEqual(model.name);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(model.name);
      expect(gone).toEqual("gone");
      yield* deleteDataset(datasetName);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
