import * as bqdt from "@distilled.cloud/gcp/bigquerydatatransfer_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  StartManualRuns,
  type StartManualRunsRequest,
} from "./StartManualRuns.ts";
import type { TransferConfig } from "./TransferConfig.ts";
import { bindGcpHost } from "../Host.ts";

/**
 * HTTP implementation of {@link StartManualRuns}.
 *
 * @layer
 * @provides GCP.BigQueryDataTransfer.StartManualRuns
 */
export const StartManualRunsHttp = Layer.effect(
  StartManualRuns,
  Effect.gen(function* () {
    const startManualRunsProjectsLocationsTransferConfigs =
      yield* bqdt.startManualRunsProjectsLocationsTransferConfigs;
    return Effect.fn(function* (config: TransferConfig) {
      yield* bindGcpHost({
        tag: "GCP.BigQueryDataTransfer.StartManualRuns",
        resource: config,
        // bigquery.transfers.update is only in roles/bigquery.admin; transfer
        // configs have no resource-level IAM.
        iam: [{ role: "roles/bigquery.admin" }],
      });
      const name = yield* config.name;
      return Effect.fn(
        `GCP.BigQueryDataTransfer.StartManualRuns(${config.LogicalId})`,
      )(function* (request?: StartManualRunsRequest) {
        return yield* startManualRunsProjectsLocationsTransferConfigs({
          ...request,
          parent: yield* name,
        });
      });
    });
  }),
);
