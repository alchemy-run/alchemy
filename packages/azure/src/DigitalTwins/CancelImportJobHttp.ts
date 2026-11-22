import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { CancelImportJob } from "./CancelImportJob.ts";

/**
 * Implementation of {@link CancelImportJob} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsImportJobCancelRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.CancelImportJob
 */
export const CancelImportJobHttp = Layer.effect(
  CancelImportJob,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.CancelImportJob",
    operation: dt.CancelImportJob,
    grant: DigitalTwinsRole.ImportJobCancel,
  }),
);
