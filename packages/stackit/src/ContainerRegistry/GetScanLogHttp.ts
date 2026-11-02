import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Layer from "effect/Layer";
import { makeHarborHttpBinding } from "./BindingHttp.ts";
import { GetScanLog } from "./GetScanLog.ts";

/**
 * HTTP implementation of {@link GetScanLog}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.GetScanLog
 */
export const GetScanLogHttp = Layer.effect(
  GetScanLog,
  makeHarborHttpBinding({
    tag: "Stackit.ContainerRegistry.GetScanLog",
    operation: harbor.getReportLog,
  }),
);
