import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Layer from "effect/Layer";
import { makeHarborHttpBinding } from "./BindingHttp.ts";
import { StopScan } from "./StopScan.ts";

/**
 * HTTP implementation of {@link StopScan}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.StopScan
 */
export const StopScanHttp = Layer.effect(
  StopScan,
  makeHarborHttpBinding({
    tag: "Stackit.ContainerRegistry.StopScan",
    operation: harbor.stopScanArtifact,
  }),
);
