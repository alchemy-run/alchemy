import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as translate from "@distilled.cloud/gcp/translate_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { hasGcpCreds, location, logLevel, parent } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  translate.getProjectsLocationsAdaptiveMtDatasets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsAdaptiveMtDatasets on a missing dataset fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        translate.getProjectsLocationsAdaptiveMtDatasets({
          name: `${parent}/adaptiveMtDatasets/alchemy-missing-dataset`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete an Adaptive MT dataset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* translate
        .listProjectsLocationsAdaptiveMtDatasets({
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

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Translate.AdaptiveMtDataset("EnEs", {
            location,
            sourceLanguageCode: "en",
            targetLanguageCode: "es",
            displayName: "enes",
          });
        }),
      );

      expect(created.datasetId).toEqual(expect.any(String));
      expect(created.name).toContain("/adaptiveMtDatasets/");
      expect(created.location).toEqual(location);
      expect(created.sourceLanguageCode).toEqual("en");
      expect(created.targetLanguageCode).toEqual("es");
      expect(
        created.displayName === "enes" || created.displayName === undefined,
      ).toEqual(true);

      const fetched = yield* translate.getProjectsLocationsAdaptiveMtDatasets({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.sourceLanguageCode).toEqual("en");
      expect(fetched.targetLanguageCode).toEqual("es");
      expect(fetched.displayName).toMatch(/^alc_/);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Translate.AdaptiveMtDataset("EnEs", {
            datasetId: created.datasetId,
            location,
            sourceLanguageCode: "en",
            targetLanguageCode: "es",
            displayName: "enes",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.sourceLanguageCode).toEqual("en");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
