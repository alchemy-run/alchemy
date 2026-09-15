import * as bqdt from "@distilled.cloud/gcp/bigquerydatatransfer_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  StartManualRuns,
  type StartManualRunsRequest,
} from "./StartManualRuns.ts";
import type { TransferConfig } from "./TransferConfig.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

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
        iam: [
          { role: defaultRoleFor("GCP.BigQueryDataTransfer.StartManualRuns") },
        ],
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
