import * as batch from "@distilled.cloud/azure/batch";
import * as Layer from "effect/Layer";
import { BatchArmRole, makeBatchPoolActionBinding } from "./ArmBindingHttp.ts";
import { StopPoolResize } from "./StopPoolResize.ts";

/**
 * Implementation of {@link StopPoolResize} over the distilled `batch` ARM
 * API. Assigns the custom `AzureBatchStopPoolResizeRole` on the pool.
 *
 * @layer
 * @provides Azure.Batch.StopPoolResize
 */
export const StopPoolResizeHttp = Layer.effect(
  StopPoolResize,
  makeBatchPoolActionBinding({
    tag: "Azure.Batch.StopPoolResize",
    operation: batch.PoolStopResize,
    role: BatchArmRole.StopPoolResize,
  }),
);
