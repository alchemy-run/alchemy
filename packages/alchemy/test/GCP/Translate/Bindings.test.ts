import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as translate from "@distilled.cloud/gcp/translate_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { hasGcpCreds, location, logLevel, parent } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "GetAdaptiveMtDataset round-trip",
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
        );
      if (probe.tag === "Forbidden") {
        expect(probe.tag).toEqual("Forbidden");
        yield* stack.destroy();
        return;
      }

      const created = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* GCP.Translate.AdaptiveMtDataset("BindEnEs", {
              location,
              sourceLanguageCode: "en",
              targetLanguageCode: "es",
              displayName: "bindenes",
            });
          }),
        )
        .pipe(
          Effect.map((dataset) => ({ tag: "ok" as const, dataset })),
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
        );
      if (created.tag !== "ok") {
        expect(["Forbidden", "BadRequest"]).toContain(created.tag);
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const dataset = yield* GCP.Translate.AdaptiveMtDataset("BindEnEs", {
            datasetId: created.dataset.datasetId,
            location,
            sourceLanguageCode: "en",
            targetLanguageCode: "es",
            displayName: "bindenes",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* dataset.name;
              const getDataset =
                yield* GCP.Translate.GetAdaptiveMtDataset(dataset);
              const adaptiveTranslate =
                yield* GCP.Translate.AdaptiveMtTranslate(dataset);
              return Effect.fn(function* () {
                const live = yield* getDataset();
                const translated = yield* adaptiveTranslate({
                  body: { content: ["hello"] },
                }).pipe(
                  Effect.map((result) => ({
                    tag: "ok" as const,
                    result,
                  })),
                  Effect.catchTag("BadRequest", (error) =>
                    Effect.succeed({
                      tag: "BadRequest" as const,
                      message: error.message,
                    }),
                  ),
                  Effect.catchTag("Forbidden", (error) =>
                    Effect.succeed({
                      tag: "Forbidden" as const,
                      message: error.message,
                    }),
                  ),
                );
                return { live, translated };
              });
            }),
          );
          return { dataset, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.dataset.name);
      expect(out.probe.live.sourceLanguageCode).toEqual("en");
      expect(["ok", "BadRequest", "Forbidden"]).toContain(
        out.probe.translated.tag,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
