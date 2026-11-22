import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { GetDeleteJob } from "./GetDeleteJob.ts";

/**
 * Implementation of {@link GetDeleteJob} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsDeleteJobReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.GetDeleteJob
 */
export const GetDeleteJobHttp = Layer.effect(
  GetDeleteJob,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.GetDeleteJob",
    operation: dt.GetDeleteJobById,
    grant: DigitalTwinsRole.DeleteJobRead,
  }),
);
