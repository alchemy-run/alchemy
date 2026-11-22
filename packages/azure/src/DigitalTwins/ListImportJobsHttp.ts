import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { ListImportJobs } from "./ListImportJobs.ts";

/**
 * Implementation of {@link ListImportJobs} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsImportJobReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.ListImportJobs
 */
export const ListImportJobsHttp = Layer.effect(
  ListImportJobs,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.ListImportJobs",
    operation: dt.ListImportJobs,
    grant: DigitalTwinsRole.ImportJobRead,
  }),
);
