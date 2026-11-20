import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as rma from "@distilled.cloud/gcp/rapidmigrationassessment_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { makeCollectorHttpBinding } from "./BindingHttp.ts";
import type { Collector } from "./Collector.ts";

export interface PauseCollectorRequest extends Omit<
  rma.PauseProjectsLocationsCollectorsRequest,
  "name"
> {}

/**
 * Runtime binding for Rapid Migration Assessment `collectors.pause`.
 *
 * Bind this operation to a {@link Collector} in a Function/Action init
 * phase. Provide {@link PauseCollectorHttp}.
 *
 * Grants `roles/rma.runner` on the project: Rapid Migration Assessment
 * has no resource-level IAM.
 *
 * ### Pausing Collectors
 * **Example:** Pause the bound collector
 * ```typescript
 * const pauseCollector = yield* GCP.RapidMigrationAssessment.PauseCollector(
 *   onPrem,
 * );
 * yield* pauseCollector();
 * ```
 *
 * @binding
 * @category RapidMigrationAssessment
 */
export interface PauseCollector extends Binding.Service<
  PauseCollector,
  "GCP.RapidMigrationAssessment.PauseCollector",
  (
    collector: Collector,
  ) => Effect.Effect<
    (
      request?: PauseCollectorRequest,
    ) => Effect.Effect<rma.Operation, rma.PauseProjectsLocationsCollectorsError, RuntimeContext>
  >
> {}

export const PauseCollector = Binding.Service<PauseCollector>(
  "GCP.RapidMigrationAssessment.PauseCollector",
);

/**
 * HTTP implementation of {@link PauseCollector}.
 *
 * @layer
 * @provides GCP.RapidMigrationAssessment.PauseCollector
 */
export const PauseCollectorHttp: Layer.Layer<
  PauseCollector,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  PauseCollector,
  makeCollectorHttpBinding<
    rma.PauseProjectsLocationsCollectorsRequest,
    rma.Operation,
    rma.PauseProjectsLocationsCollectorsError
  >({
    tag: "GCP.RapidMigrationAssessment.PauseCollector",
    iam: { role: "roles/rma.runner" },
    operation: rma.pauseProjectsLocationsCollectors,
  }),
);
