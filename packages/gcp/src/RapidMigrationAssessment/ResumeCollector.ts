import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as rma from "@distilled.cloud/gcp/rapidmigrationassessment_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { makeCollectorHttpBinding } from "./BindingHttp.ts";
import type { Collector } from "./Collector.ts";

export interface ResumeCollectorRequest extends Omit<
  rma.ResumeProjectsLocationsCollectorsRequest,
  "name"
> {}

/**
 * Runtime binding for Rapid Migration Assessment `collectors.resume`.
 *
 * Bind this operation to a {@link Collector} in a Function/Action init
 * phase. Provide {@link ResumeCollectorHttp}.
 *
 * Grants `roles/rma.runner` on the project: Rapid Migration Assessment
 * has no resource-level IAM.
 *
 * ### Resuming Collectors
 * **Example:** Resume the bound collector
 * ```typescript
 * const resumeCollector = yield* GCP.RapidMigrationAssessment.ResumeCollector(
 *   onPrem,
 * );
 * yield* resumeCollector();
 * ```
 *
 * @binding
 * @category RapidMigrationAssessment
 */
export interface ResumeCollector extends Binding.Service<
  ResumeCollector,
  "GCP.RapidMigrationAssessment.ResumeCollector",
  (
    collector: Collector,
  ) => Effect.Effect<
    (
      request?: ResumeCollectorRequest,
    ) => Effect.Effect<rma.Operation, rma.ResumeProjectsLocationsCollectorsError, RuntimeContext>
  >
> {}

export const ResumeCollector = Binding.Service<ResumeCollector>(
  "GCP.RapidMigrationAssessment.ResumeCollector",
);

/**
 * HTTP implementation of {@link ResumeCollector}.
 *
 * @layer
 * @provides GCP.RapidMigrationAssessment.ResumeCollector
 */
export const ResumeCollectorHttp: Layer.Layer<
  ResumeCollector,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  ResumeCollector,
  makeCollectorHttpBinding<
    rma.ResumeProjectsLocationsCollectorsRequest,
    rma.Operation,
    rma.ResumeProjectsLocationsCollectorsError
  >({
    tag: "GCP.RapidMigrationAssessment.ResumeCollector",
    iam: { role: "roles/rma.runner" },
    operation: rma.resumeProjectsLocationsCollectors,
  }),
);
