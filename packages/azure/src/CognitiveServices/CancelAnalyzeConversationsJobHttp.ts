import * as conversations from "@distilled.cloud/azure/cognitiveservices-language-analyze-conversations";
import * as Layer from "effect/Layer";
import { LanguageRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { CancelAnalyzeConversationsJob } from "./CancelAnalyzeConversationsJob.ts";

/**
 * Implementation of {@link CancelAnalyzeConversationsJob} over the distilled `cognitiveservices-language-analyze-conversations`
 * data plane. Assigns the custom `AzureCognitiveServicesLanguageCancelAnalyzeConversationsJobRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CancelAnalyzeConversationsJob
 */
export const CancelAnalyzeConversationsJobHttp = Layer.effect(
  CancelAnalyzeConversationsJob,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.CancelAnalyzeConversationsJob",
    operation: conversations.AnalyzeConversationsCancelJob,
    grant: LanguageRole.CancelAnalyzeConversationsJob,
  }),
);
