import * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Layer from "effect/Layer";
import { makeProjectLinkHttpBinding } from "./LinkBindingHttp.ts";
import { ListProjectBackflushJobs } from "./ListProjectBackflushJobs.ts";

/**
 * HTTP implementation of {@link ListProjectBackflushJobs}.
 *
 * @layer
 * @provides Stackit.Telemetry.ListProjectBackflushJobs
 */
export const ListProjectBackflushJobsHttp = Layer.effect(
  ListProjectBackflushJobs,
  makeProjectLinkHttpBinding({
    tag: "Stackit.Telemetry.ListProjectBackflushJobs",
    permission: "telemetry-link.instance.get",
    operation: telemetry.listProjectBackflushJobs,
  }),
);
