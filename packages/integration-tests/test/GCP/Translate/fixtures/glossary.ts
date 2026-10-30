import * as GCP from "@alchemy.run/gcp";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

/** English → Spanish glossary built from a one-line TSV in its own bucket. */
export const EnEsGlossary = Effect.gen(function* () {
  const bucket = yield* GCP.Storage.Bucket("GlossarySrc", {
    location: "US-CENTRAL1",
    forceDestroy: true,
  });
  const terms = yield* GCP.Storage.Object("GlossaryTerms", {
    bucketName: bucket.bucketName,
    key: "glossary.tsv",
    content: "hello\thola\n",
  });
  return yield* GCP.Translate.Glossary("EnEs", {
    source: Output.interpolate`gs://${terms.bucketName}/${terms.key}`,
    languagePair: { sourceLanguageCode: "en", targetLanguageCode: "es" },
  });
});
