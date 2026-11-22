import * as qna from "@distilled.cloud/azure/cognitiveservices-language-question-answering";
import * as Layer from "effect/Layer";
import { LanguageRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { GetAnswers } from "./GetAnswers.ts";

/**
 * Implementation of {@link GetAnswers} over the distilled `cognitiveservices-language-question-answering`
 * data plane. Assigns the custom `AzureCognitiveServicesLanguageQueryKnowledgeBasesRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetAnswers
 */
export const GetAnswersHttp = Layer.effect(
  GetAnswers,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.GetAnswers",
    operation: qna.GetQuestionAnsweringAnswers,
    grant: LanguageRole.QueryKnowledgeBases,
  }),
);
