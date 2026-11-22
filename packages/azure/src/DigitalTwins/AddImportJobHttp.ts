import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { AddImportJob } from "./AddImportJob.ts";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AddImportJob} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsImportJobWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.AddImportJob
 */
export const AddImportJobHttp = Layer.effect(
  AddImportJob,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.AddImportJob",
    operation: dt.AddImportJob,
    grant: DigitalTwinsRole.ImportJobWrite,
  }),
);
