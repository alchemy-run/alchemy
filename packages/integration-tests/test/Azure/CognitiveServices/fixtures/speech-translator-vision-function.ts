import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

// One account per service the bindings target. Each is pay-per-call (S1
// Translator and Vision, S0 Speech): an idle account costs $0. `eastus`
// hosts fast transcription and multimodal embeddings.
export const Translator = Azure.CognitiveServices.Account("StvTranslator", {
  kind: "TextTranslation",
  sku: "S1",
  location: "eastus",
});
export const Speech = Azure.CognitiveServices.Account("StvSpeech", {
  kind: "SpeechServices",
  sku: "S0",
  location: "eastus",
});
export const Vision = Azure.CognitiveServices.Account("StvVision", {
  kind: "ComputerVision",
  sku: "S1",
  location: "eastus",
});

/** A 3-second English WAV: "What's the weather like?". */
export const WEATHER_WAV =
  "https://raw.githubusercontent.com/Azure-Samples/cognitive-services-speech-sdk/master/samples/csharp/sharedcontent/console/whatstheweatherlike.wav";

/** A photo of a landmark. */
export const LANDMARK_JPG =
  "https://raw.githubusercontent.com/Azure-Samples/cognitive-services-sample-data-files/master/ComputerVision/Images/landmark.jpg";

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result: result ?? null })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/** A binding callable; each takes its own request type. */
type Call = (request: never) => Effect.Effect<unknown, unknown, RuntimeContext>;

/**
 * Effect Function with one route per Speech, Translator, and Vision
 * binding: `POST /<Binding>` with the binding's request as the JSON body
 * calls it and answers `{ ok, result | error }` (a 500 on error, so a caller
 * retries through role propagation and a real failure shows the Azure
 * error). `POST /TranscribeAudioFile` with `{ url, locales }` downloads the
 * audio and uploads its bytes.
 */
export default class SpeechTranslatorVisionFunction extends Azure.Functions.Function<SpeechTranslatorVisionFunction>()(
  "SpeechTranslatorVisionFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const translator = yield* Translator;
    const speech = yield* Speech;
    const vision = yield* Vision;
    const C = Azure.CognitiveServices;
    const transcribeAudio = yield* C.TranscribeAudio(speech);
    const calls: Record<string, Call> = {
      // Translator
      TranslateText: yield* C.TranslateText(translator),
      TransliterateText: yield* C.TransliterateText(translator),
      DetectTextLanguage: yield* C.DetectTextLanguage(translator),
      BreakSentences: yield* C.BreakSentences(translator),
      LookupDictionary: yield* C.LookupDictionary(translator),
      LookupDictionaryExamples: yield* C.LookupDictionaryExamples(translator),
      ListTranslatorLanguages: yield* C.ListTranslatorLanguages(translator),
      // Speech
      TranscribeAudio: transcribeAudio,
      SubmitTranscription: yield* C.SubmitTranscription(speech),
      GetTranscription: yield* C.GetTranscription(speech),
      ListTranscriptionFiles: yield* C.ListTranscriptionFiles(speech),
      DeleteTranscription: yield* C.DeleteTranscription(speech),
      // Vision
      VectorizeImage: yield* C.VectorizeImage(vision),
      VectorizeText: yield* C.VectorizeText(vision),
    };

    /** Download `url` and transcribe its bytes as a multipart `audio` part. */
    const transcribeFile = (request: { url: string; locales: string[] }) =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get(request.url);
        const audio = new Uint8Array(yield* response.arrayBuffer);
        return yield* transcribeAudio({ definition: { locales: request.locales }, audio });
      }).pipe(Effect.provide(FetchHttpClient.layer));

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed({})));
        const route = url.pathname.slice(1);
        if (route === "TranscribeAudioFile") {
          return yield* respond(transcribeFile(body as { url: string; locales: string[] }));
        }
        const call = calls[route];
        if (call === undefined) {
          return HttpServerResponse.text("not found", { status: 404 });
        }
        // The test sends the binding's own request type as JSON.
        return yield* respond(call(body as never));
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.CognitiveServices.TranslateTextHttp,
        Azure.CognitiveServices.TransliterateTextHttp,
        Azure.CognitiveServices.DetectTextLanguageHttp,
        Azure.CognitiveServices.BreakSentencesHttp,
        Azure.CognitiveServices.LookupDictionaryHttp,
        Azure.CognitiveServices.LookupDictionaryExamplesHttp,
        Azure.CognitiveServices.ListTranslatorLanguagesHttp,
        Azure.CognitiveServices.TranscribeAudioHttp,
        Azure.CognitiveServices.SubmitTranscriptionHttp,
        Azure.CognitiveServices.GetTranscriptionHttp,
        Azure.CognitiveServices.ListTranscriptionFilesHttp,
        Azure.CognitiveServices.DeleteTranscriptionHttp,
        Azure.CognitiveServices.VectorizeImageHttp,
        Azure.CognitiveServices.VectorizeTextHttp,
      ),
    ),
  ),
) {}
