import * as conversations from "@distilled.cloud/azure/cognitiveservices-language-analyze-conversations";
import * as Layer from "effect/Layer";
import { LanguageRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { GetAnalyzeConversationsJob } from "./GetAnalyzeConversationsJob.ts";

/**
 * Implementation of {@link GetAnalyzeConversationsJob} over the distilled `cognitiveservices-language-analyze-conversations`
 * data plane. Assigns the custom `AzureCognitiveServicesLanguageReadAnalyzeConversationsJobRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetAnalyzeConversationsJob
 */
export const GetAnalyzeConversationsJobHttp = Layer.effect(
  GetAnalyzeConversationsJob,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.GetAnalyzeConversationsJob",
    operation: conversations.AnalyzeConversationsJobStatus,
    grant: LanguageRole.ReadAnalyzeConversationsJob,
  }),
);
