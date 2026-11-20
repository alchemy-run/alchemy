import * as speech from "@distilled.cloud/gcp/speech_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePhraseSetHttpBinding } from "./BindingHttp.ts";
import type { PhraseSet } from "./PhraseSet.ts";

export interface RecognizeRequest {
  /**
   * Recognize body. The bound PhraseSet is added to
   * `config.adaptation.phraseSetReferences`.
   */
  body?: speech.RecognizeRequest;
}

/**
 * Runtime binding for Speech-to-Text `speech.recognize` using a PhraseSet
 * as Adaptation.
 *
 * Bind this operation to a {@link PhraseSet} in a Function/Action init
 * phase. Provide {@link RecognizeHttp}.
 *
 * Grants `roles/speech.client` on the project because Speech-to-Text has no
 * resource-level IAM.
 *
 * ### Recognizing Speech
 * **Example:** Transcribe audio with phrase hints
 * ```typescript
 * const recognize = yield* GCP.Speech.Recognize(hints);
 * const result = yield* recognize({
 *   body: {
 *     config: { languageCode: "en-US" },
 *     audio: { uri: "gs://bucket/clip.flac" },
 *   },
 * });
 * ```
 *
 * @binding
 * @category Speech
 */
export interface Recognize extends Binding.Service<
  Recognize,
  "GCP.Speech.Recognize",
  (
    phraseSet: PhraseSet,
  ) => Effect.Effect<
    (
      request?: RecognizeRequest,
    ) => Effect.Effect<speech.RecognizeResponse, speech.RecognizeSpeechError, RuntimeContext>
  >
> {}

export const Recognize = Binding.Service<Recognize>("GCP.Speech.Recognize");

/**
 * HTTP implementation of {@link Recognize}.
 *
 * @layer
 * @provides GCP.Speech.Recognize
 */
export const RecognizeHttp = Layer.effect(
  Recognize,
  makePhraseSetHttpBinding<
    speech.RecognizeSpeechRequest,
    speech.RecognizeResponse,
    speech.RecognizeSpeechError,
    RecognizeRequest
  >({
    tag: "GCP.Speech.Recognize",
    operation: speech.recognizeSpeech,
    iam: { role: "roles/speech.client" },
    toInput: (name, request) => {
      const body = request?.body ?? {};
      const config = body.config ?? {};
      const adaptation = config.adaptation ?? {};
      const references = [...(adaptation.phraseSetReferences ?? []), name].filter(
        (value, index, all) => all.indexOf(value) === index,
      );
      return {
        body: {
          ...body,
          config: {
            ...config,
            adaptation: {
              ...adaptation,
              phraseSetReferences: references,
            },
          },
        },
      };
    },
  }),
);
