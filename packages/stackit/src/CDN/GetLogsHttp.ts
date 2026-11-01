import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Layer from "effect/Layer";
import { CDN_READ_ACCESS, makeDistributionHttpBinding } from "./BindingHttp.ts";
import { GetLogs } from "./GetLogs.ts";

/**
 * HTTP implementation of {@link GetLogs}.
 *
 * @layer
 * @provides Stackit.CDN.GetLogs
 */
export const GetLogsHttp = Layer.effect(
  GetLogs,
  makeDistributionHttpBinding({
    tag: "Stackit.CDN.GetLogs",
    access: CDN_READ_ACCESS,
    operation: cdn.getLogs,
  }),
);
