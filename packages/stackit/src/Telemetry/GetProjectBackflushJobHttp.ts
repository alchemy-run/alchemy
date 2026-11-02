import * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Layer from "effect/Layer";
import { GetProjectBackflushJob } from "./GetProjectBackflushJob.ts";
import { makeProjectLinkHttpBinding } from "./LinkBindingHttp.ts";

/**
 * HTTP implementation of {@link GetProjectBackflushJob}.
 *
 * @layer
 * @provides Stackit.Telemetry.GetProjectBackflushJob
 */
export const GetProjectBackflushJobHttp = Layer.effect(
  GetProjectBackflushJob,
  makeProjectLinkHttpBinding({
    tag: "Stackit.Telemetry.GetProjectBackflushJob",
    permission: "telemetry-link.instance.get",
    operation: telemetry.getProjectBackflushJob,
  }),
);
