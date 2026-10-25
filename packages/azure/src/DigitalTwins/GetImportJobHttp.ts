import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { GetImportJob } from "./GetImportJob.ts";

/**
 * Implementation of {@link GetImportJob} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsImportJobReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.GetImportJob
 */
export const GetImportJobHttp = Layer.effect(
  GetImportJob,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.GetImportJob",
    operation: dt.GetImportJobById,
    grant: DigitalTwinsRole.ImportJobRead,
  }),
);
