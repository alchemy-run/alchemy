import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";
import { EnEsGlossary } from "./glossary.ts";

const location = "us-central1";

/**
 * Model bindings need a trained model: training takes hours, so
 * `GCP_TEST_TRANSLATE_MODEL=1` plus `GCP_TEST_TRANSLATE_MODEL_DATASET` (a
 * dataset with imported sentence pairs) opt in. The gate values are
 * forwarded to the host's environment so the deployed runtime binds the
 * same set.
 */
export const modelDataset =
  !process.env.FAST && process.env.GCP_TEST_TRANSLATE_MODEL === "1"
    ? (process.env.GCP_TEST_TRANSLATE_MODEL_DATASET ?? "")
    : "";

/** Adaptive MT dataset (no sentence pairs) the dataset bindings bind. */
export const Dataset = GCP.Translate.AdaptiveMtDataset("BindEnEs", {
  location,
  sourceLanguageCode: "en",
  targetLanguageCode: "es",
  displayName: "bindenes",
});

/** Custom model; declared only when {@link modelDataset} is set. */
export const EnEs = GCP.Translate.Model("EnEs", {
  location,
  dataset: modelDataset,
  displayName: "enes",
});

/** Glossary entry the entry binding binds. */
export const Hello = Effect.gen(function* () {
  const glossary = yield* EnEsGlossary;
  return yield* GCP.Translate.GlossariesGlossaryEntry("Hello", {
    parent: glossary.name,
    location,
    description: "greeting",
    termsPair: {
      sourceTerm: { languageCode: "en", text: "hello" },
      targetTerm: { languageCode: "es", text: "hola" },
    },
  });
});

const modelProbes = Effect.gen(function* () {
  const getModel = yield* GCP.Translate.GetModel(EnEs);
  const translateText = yield* GCP.Translate.TranslateText(EnEs);
  return {
    getModel: getModel(),
    translateText: translateText({
      body: {
        contents: ["Hello, world"],
        targetLanguageCode: "es",
        sourceLanguageCode: "en",
        mimeType: "text/plain",
      },
    }),
  };
});

const glossaryProbes = Effect.gen(function* () {
  const getEntry = yield* GCP.Translate.GetGlossariesGlossaryEntry(Hello);
  return { getGlossaryEntry: getEntry() };
});

/**
 * Effect-native Cloud Run service exercising every Translate binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class TranslateBindingsHost extends GCP.Function<TranslateBindingsHost>()(
  "TranslateBindingsHost",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
    env: {
      GCP_TEST_TRANSLATE_MODEL: modelDataset ? "1" : "",
      GCP_TEST_TRANSLATE_MODEL_DATASET: modelDataset,
    },
  },
  Effect.gen(function* () {
    const getDataset = yield* GCP.Translate.GetAdaptiveMtDataset(Dataset);
    const adaptiveTranslate = yield* GCP.Translate.AdaptiveMtTranslate(Dataset);
    const model = modelDataset ? yield* modelProbes : {};
    const glossary = yield* glossaryProbes;

    return {
      fetch: serveProbes({
        getAdaptiveMtDataset: getDataset(),
        adaptiveMtTranslate: adaptiveTranslate({
          body: { content: ["hello"] },
        }),
        ...model,
        ...glossary,
      }),
    };
  }).pipe(
    Effect.provide(GCP.Translate.GetAdaptiveMtDatasetHttp),
    Effect.provide(GCP.Translate.AdaptiveMtTranslateHttp),
    Effect.provide(GCP.Translate.GetModelHttp),
    Effect.provide(GCP.Translate.TranslateTextHttp),
    Effect.provide(GCP.Translate.GetGlossariesGlossaryEntryHttp),
  ),
) {}
