import * as conversations from "@distilled.cloud/azure/cognitiveservices-language-analyze-conversations";
import * as Layer from "effect/Layer";
import { LanguageRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { AnalyzeConversations } from "./AnalyzeConversations.ts";

/**
 * Implementation of {@link AnalyzeConversations} over the distilled `cognitiveservices-language-analyze-conversations`
 * data plane. Assigns the custom `AzureCognitiveServicesLanguageAnalyzeConversationsRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AnalyzeConversations
 */
export const AnalyzeConversationsHttp = Layer.effect(
  AnalyzeConversations,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.AnalyzeConversations",
    operation: conversations.AnalyzeConversations,
    grant: LanguageRole.AnalyzeConversations,
  }),
);
