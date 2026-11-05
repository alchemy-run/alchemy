import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTranscribeHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `transcribe:ListLanguageModels` — list the custom language models in the account.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:ListLanguageModels` on `*`.
 *
 * ### Custom Language Models
 * **Example:** List Custom Language Models
 * ```typescript
 * // init
 * const listLanguageModels = yield* AWS.Transcribe.ListLanguageModels();
 *
 * // runtime
 * const { Models } = yield* listLanguageModels({ MaxResults: 10 });
 * ```
 *
 * @binding
 */
export interface ListLanguageModels extends Binding.Service<
  ListLanguageModels,
  "AWS.Transcribe.ListLanguageModels",
  () => Effect.Effect<
    (
      request?: transcribe.ListLanguageModelsRequest,
    ) => Effect.Effect<transcribe.ListLanguageModelsResponse, transcribe.ListLanguageModelsError>
  >
> {}
export const ListLanguageModels = Binding.Service<ListLanguageModels>(
  "AWS.Transcribe.ListLanguageModels",
);

export const ListLanguageModelsHttp = Layer.effect(
  ListLanguageModels,
  makeTranscribeHttpBinding({
    tag: "AWS.Transcribe.ListLanguageModels",
    operation: transcribe.listLanguageModels,
    actions: ["transcribe:ListLanguageModels"],
  }),
);
