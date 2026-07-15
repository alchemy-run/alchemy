import * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import * as Layer from "effect/Layer";
import { makeBdaLibraryHttpBinding } from "./BindingHttp.ts";
import { GetDataAutomationLibraryIngestionJob } from "./GetDataAutomationLibraryIngestionJob.ts";

export const GetDataAutomationLibraryIngestionJobHttp = Layer.effect(
  GetDataAutomationLibraryIngestionJob,
  makeBdaLibraryHttpBinding({
    tag: "AWS.BedrockDataAutomation.GetDataAutomationLibraryIngestionJob",
    operation: bda.getDataAutomationLibraryIngestionJob,
    actions: ["bedrock:GetDataAutomationLibraryIngestionJob"],
  }),
);
