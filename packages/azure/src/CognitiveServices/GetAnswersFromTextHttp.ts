import * as qna from "@distilled.cloud/azure/cognitiveservices-language-question-answering";
import * as Layer from "effect/Layer";
import { LanguageRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { GetAnswersFromText } from "./GetAnswersFromText.ts";

/**
 * Implementation of {@link GetAnswersFromText} over the distilled `cognitiveservices-language-question-answering`
 * data plane. Assigns the custom `AzureCognitiveServicesLanguageQueryTextRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetAnswersFromText
 */
export const GetAnswersFromTextHttp = Layer.effect(
  GetAnswersFromText,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.GetAnswersFromText",
    operation: qna.GetQuestionAnsweringAnswersFromText,
    grant: LanguageRole.QueryText,
  }),
);
