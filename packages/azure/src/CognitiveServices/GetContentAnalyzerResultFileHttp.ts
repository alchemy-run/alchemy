import * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetContentAnalyzerResultFile } from "./GetContentAnalyzerResultFile.ts";

/**
 * Implementation of {@link GetContentAnalyzerResultFile} over the distilled `ai-content-understanding`
 * data plane. Assigns the custom `AzureAIContentResultFilesReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetContentAnalyzerResultFile
 */
export const GetContentAnalyzerResultFileHttp = Layer.effect(
  GetContentAnalyzerResultFile,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetContentAnalyzerResultFile",
    operation: cu.GetContentAnalyzerResultFile,
    grant: AIRole.ContentResultFilesRead,
  }),
);
