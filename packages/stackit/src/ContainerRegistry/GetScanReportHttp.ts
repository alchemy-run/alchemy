import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Layer from "effect/Layer";
import { makeHarborHttpBinding } from "./BindingHttp.ts";
import { GetScanReport } from "./GetScanReport.ts";

/**
 * HTTP implementation of {@link GetScanReport}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.GetScanReport
 */
export const GetScanReportHttp = Layer.effect(
  GetScanReport,
  makeHarborHttpBinding({
    tag: "Stackit.ContainerRegistry.GetScanReport",
    operation: harbor.getVulnerabilitiesAddition,
  }),
);
