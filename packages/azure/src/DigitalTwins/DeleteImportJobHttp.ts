import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { DeleteImportJob } from "./DeleteImportJob.ts";

/**
 * Implementation of {@link DeleteImportJob} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsImportJobDeleteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.DeleteImportJob
 */
export const DeleteImportJobHttp = Layer.effect(
  DeleteImportJob,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.DeleteImportJob",
    operation: dt.DeleteImportJob,
    grant: DigitalTwinsRole.ImportJobDelete,
  }),
);
