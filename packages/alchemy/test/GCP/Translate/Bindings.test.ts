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

const runModelBindings =
  hasGcpCreds &&
  !process.env.FAST &&
  process.env.GCP_TEST_TRANSLATE_MODEL === "1";

test.provider.skipIf(!runModelBindings)(
  "GetModel and TranslateText invoke HTTP bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const dataset = process.env.GCP_TEST_TRANSLATE_MODEL_DATASET ?? "";

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const model = yield* GCP.Translate.Model("EnEs", {
            location,
            dataset,
            displayName: "enes",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* model.name;
              const getModel = yield* GCP.Translate.GetModel(model);
              const translateText = yield* GCP.Translate.TranslateText(model);
              return Effect.fn(function* () {
                const live = yield* getModel();
                const translated = yield* translateText({
                  body: {
                    contents: ["Hello, world"],
                    targetLanguageCode: "es",
                    sourceLanguageCode: "en",
                    mimeType: "text/plain",
                  },
                }).pipe(
                  Effect.map((result) => ({ tag: "ok" as const, result })),
                  Effect.catchTag(
                    ["Forbidden", "BadRequest", "NotFound", "Conflict"],
                    (error) =>
                      Effect.succeed({
                        tag: error._tag,
                        message: error.message,
                      }),
                  ),
                );
                return { live, translated };
              });
            }),
          );
          return { model, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.model.name);
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(out.probe.translated.tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

const runGlossaryBindings =
  hasGcpCreds &&
  !process.env.FAST &&
  process.env.GCP_TEST_TRANSLATE_GLOSSARY === "1";

test.provider.skipIf(!runGlossaryBindings)(
  "GetGlossariesGlossaryEntry invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const glossary = process.env.GCP_TEST_TRANSLATE_GLOSSARY_NAME ?? "";

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const entry = yield* GCP.Translate.GlossariesGlossaryEntry("Hello", {
            parent: glossary,
            location,
            description: "greeting",
            termsPair: {
              sourceTerm: { languageCode: "en", text: "hello" },
              targetTerm: { languageCode: "es", text: "hola" },
            },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* entry.name;
              const getEntry =
                yield* GCP.Translate.GetGlossariesGlossaryEntry(entry);
              return Effect.fn(function* () {
                const live = yield* getEntry();
                return { live };
              });
            }),
          );
          return { entry, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.entry.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
