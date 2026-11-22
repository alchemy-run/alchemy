import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { AddDeleteJob } from "./AddDeleteJob.ts";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AddDeleteJob} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsDeleteJobWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.AddDeleteJob
 */
export const AddDeleteJobHttp = Layer.effect(
  AddDeleteJob,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.AddDeleteJob",
    operation: dt.AddDeleteJob,
    grant: DigitalTwinsRole.DeleteJobWrite,
  }),
);
