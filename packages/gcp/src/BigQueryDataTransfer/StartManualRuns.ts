import * as bqdt from "@distilled.cloud/gcp/bigquerydatatransfer_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import type { TransferConfig } from "./TransferConfig.ts";

export interface StartManualRunsRequest extends Omit<
  bqdt.StartManualRunsProjectsLocationsTransferConfigsRequest,
  "parent"
> {}

/**
 * Runtime binding for BigQuery Data Transfer `transferConfigs.startManualRuns`.
 *
 * Starts one or more transfer runs for a {@link TransferConfig}. Bind this
 * operation in a Function/Action init phase. Provide
 * {@link StartManualRunsHttp}. `requestedRunTime` and `requestedTimeRange`
 * must be in the past.
 *
 * Grants `roles/bigquery.admin` on the project because
 * `bigquery.transfers.update` (required by `startManualRuns`) is in no
 * narrower predefined role, and transfer configs have no resource-level
 * IAM or IAM Conditions support to scope it to the one config.
 *
 * ### Starting Manual Runs
 * **Example:** Run for a specific past timestamp
 * ```typescript
 * const start = yield* GCP.BigQueryDataTransfer.StartManualRuns(nightly);
 * const result = yield* start({
 *   body: { requestedRunTime: "2020-01-01T00:00:00Z" },
 * });
 * ```
 *
 * @binding
 * @category BigQueryDataTransfer
 */
export interface StartManualRuns extends Binding.Service<
  StartManualRuns,
  "GCP.BigQueryDataTransfer.StartManualRuns",
  (
    config: TransferConfig,
  ) => Effect.Effect<
    (
      request?: StartManualRunsRequest,
    ) => Effect.Effect<
      bqdt.StartManualTransferRunsResponse,
      bqdt.StartManualRunsProjectsLocationsTransferConfigsError,
      RuntimeContext
    >
  >
> {}

export const StartManualRuns = Binding.Service<StartManualRuns>(
  "GCP.BigQueryDataTransfer.StartManualRuns",
);

/**
 * HTTP implementation of {@link StartManualRuns}.
 *
 * @layer
 * @provides GCP.BigQueryDataTransfer.StartManualRuns
 */
export const StartManualRunsHttp = Layer.effect(
  StartManualRuns,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const startManualRunsProjectsLocationsTransferConfigs = yield* GCPBindings.withCredentials(
      bqdt.startManualRunsProjectsLocationsTransferConfigs,
    );
    return Effect.fn(function* (config: TransferConfig) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.BigQueryDataTransfer.StartManualRuns(${config})`({
          // bigquery.transfers.update is in no narrower predefined role, and
          // transfer configs have no resource-level IAM, so this is a project
          // grant (see StartManualRuns JSDoc).
          iam: [{ role: "roles/bigquery.admin" }],
        });
      }
      const name = yield* config.name;
      return Effect.fn(`GCP.BigQueryDataTransfer.StartManualRuns(${config.LogicalId})`)(function* (
        request?: StartManualRunsRequest,
      ) {
        return yield* startManualRunsProjectsLocationsTransferConfigs({
          ...request,
          parent: yield* name,
        });
      });
    });
  }),
);
