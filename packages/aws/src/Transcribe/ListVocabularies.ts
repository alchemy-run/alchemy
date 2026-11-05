import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `transcribe:ListVocabularies` — list the custom vocabularies in the account.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:ListVocabularies` on `*`.
 *
 * ### Custom Vocabularies
 * **Example:** List Custom Vocabularies
 * ```typescript
 * // init
 * const listVocabularies = yield* AWS.Transcribe.ListVocabularies();
 *
 * // runtime
 * const { Vocabularies } = yield* listVocabularies({ MaxResults: 10 });
 * ```
 *
 * @binding
 */
export interface ListVocabularies extends Binding.Service<
  ListVocabularies,
  "AWS.Transcribe.ListVocabularies",
  () => Effect.Effect<
    (
      request?: transcribe.ListVocabulariesRequest,
    ) => Effect.Effect<transcribe.ListVocabulariesResponse, transcribe.ListVocabulariesError>
  >
> {}
export const ListVocabularies = Binding.Service<ListVocabularies>(
  "AWS.Transcribe.ListVocabularies",
);

export const ListVocabulariesHttp = Layer.effect(
  ListVocabularies,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.ListVocabularies",
    operation: transcribe.listVocabularies,
    actions: ["transcribe:ListVocabularies"],
  }),
);
