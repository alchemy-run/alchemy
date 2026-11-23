import * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { makeBdaLibraryHttpBinding } from "./BindingHttp.ts";
import { ListDataAutomationLibraryIngestionJobs } from "./ListDataAutomationLibraryIngestionJobs.ts";

export const ListDataAutomationLibraryIngestionJobsHttp = Layer.effect(
  ListDataAutomationLibraryIngestionJobs,
  makeBdaLibraryHttpBinding({
    tag: "AWS.BedrockDataAutomation.ListDataAutomationLibraryIngestionJobs",
    operation: bda.listDataAutomationLibraryIngestionJobs,
    actions: ["bedrock:ListDataAutomationLibraryIngestionJobs"],
    // The action authorizes against the ingestion-job resource (minted at
    // runtime), not the library ARN.
    additionalResources: [
      AWSBindings.partitionArn("bedrock:*:*:data-automation-library-ingestion-job/*"),
    ],
  }),
);
