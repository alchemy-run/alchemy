import * as conversations from "@distilled.cloud/azure/cognitiveservices-language-analyze-conversations";
import * as Layer from "effect/Layer";
import { LanguageRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { SubmitAnalyzeConversationsJob } from "./SubmitAnalyzeConversationsJob.ts";

/**
 * Implementation of {@link SubmitAnalyzeConversationsJob} over the distilled `cognitiveservices-language-analyze-conversations`
 * data plane. Assigns the custom `AzureCognitiveServicesLanguageSubmitAnalyzeConversationsJobRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.SubmitAnalyzeConversationsJob
 */
export const SubmitAnalyzeConversationsJobHttp = Layer.effect(
  SubmitAnalyzeConversationsJob,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.SubmitAnalyzeConversationsJob",
    operation: conversations.AnalyzeConversationsSubmitJob,
    grant: LanguageRole.SubmitAnalyzeConversationsJob,
  }),
);
