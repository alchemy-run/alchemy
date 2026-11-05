import * as fis from "@distilled.cloud/aws/fis";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFisAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `fis:ListExperiments`.
 *
 * Enumerates the account's experiments, optionally filtered to those started
 * from a specific template — the building block of a chaos-run dashboard or
 * a guard that refuses to start a new experiment while one is already
 * running. Provide the implementation with
 * `Effect.provide(AWS.FIS.ListExperimentsHttp)`.
 * ### Running Experiments
 * **Example:** Find Running Experiments for a Template
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listExperiments = yield* AWS.FIS.ListExperiments();
 *
 * // runtime
 * const { experiments } = yield* listExperiments({
 *   experimentTemplateId: templateId,
 * });
 * const running = (experiments ?? []).filter(
 *   (e) => e.state?.status === "running",
 * );
 * ```
 *
 * @binding
 */
export interface ListExperiments extends Binding.Service<
  ListExperiments,
  "AWS.FIS.ListExperiments",
  () => Effect.Effect<
    (
      request?: fis.ListExperimentsRequest,
    ) => Effect.Effect<fis.ListExperimentsResponse, fis.ListExperimentsError>
  >
> {}
export const ListExperiments = Binding.Service<ListExperiments>("AWS.FIS.ListExperiments");

export const ListExperimentsHttp = Layer.effect(
  ListExperiments,
  makeFisAccountHttpBinding({
    tag: "AWS.FIS.ListExperiments",
    operation: fis.listExperiments,
    actions: ["fis:ListExperiments"],
  }),
);
