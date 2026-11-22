import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { ListDeleteJobs } from "./ListDeleteJobs.ts";

/**
 * Implementation of {@link ListDeleteJobs} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsDeleteJobReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.ListDeleteJobs
 */
export const ListDeleteJobsHttp = Layer.effect(
  ListDeleteJobs,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.ListDeleteJobs",
    operation: dt.ListDeleteJobs,
    grant: DigitalTwinsRole.DeleteJobRead,
  }),
);
