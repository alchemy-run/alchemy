import type * as SVC from "@distilled.cloud/aws/databrew";
import * as databrew from "@distilled.cloud/aws/databrew";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeDataBrewJobHttpBinding } from "./BindingHttp.ts";
import type { Job } from "./Job.ts";

/**
 * Runtime binding for `databrew:StartJobRun` — lets a workload kick off a
 * run of a DataBrew job (a `PROFILE` analysis or a `RECIPE` transformation).
 *
 * The response carries the `RunId`, which can be observed with the
 * {@link DescribeJobRun} binding and cancelled with {@link StopJobRun}.
 * ### Starting Job Runs
 * **Example:** Start a Job Run
 * ```typescript
 * const startJobRun = yield* AWS.DataBrew.StartJobRun(job);
 *
 * const { RunId } = yield* startJobRun();
 * ```
 *
 * @binding
 */
export interface StartJobRun extends Binding.Service<
  StartJobRun,
  "AWS.DataBrew.StartJobRun",
  <J extends Job>(
    job: J,
  ) => Effect.Effect<() => Effect.Effect<SVC.StartJobRunResponse, SVC.StartJobRunError>>
> {}
export const StartJobRun = Binding.Service<StartJobRun>("AWS.DataBrew.StartJobRun");

export const StartJobRunHttp = Layer.effect(
  StartJobRun,
  makeDataBrewJobHttpBinding({
    tag: "AWS.DataBrew.StartJobRun",
    operation: databrew.startJobRun,
    actions: ["databrew:StartJobRun"],
  }),
);
