import * as amplify from "@distilled.cloud/aws/amplify";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { App } from "./App.ts";
import { makeAmplifyHttpBinding } from "./BindingHttp.ts";

export interface StopJobRequest extends Omit<amplify.StopJobRequest, "appId"> {}

/**
 * Runtime binding for `amplify:StopJob`.
 *
 * Bind an {@link App} in the function's init phase to get a callable that
 * cancels an in-progress build job on one of the app's branches. Provide the
 * implementation with `Effect.provide(AWS.Amplify.StopJobHttp)`.
 * ### Controlling Jobs
 * **Example:** Cancel a Running Build
 * ```typescript
 * // init — bind the operation to the app
 * const stopJob = yield* AWS.Amplify.StopJob(app);
 *
 * // runtime — cancel the job
 * const { jobSummary } = yield* stopJob({
 *   branchName: "main",
 *   jobId: "42",
 * });
 * ```
 *
 * @binding
 */
export interface StopJob extends Binding.Service<
  StopJob,
  "AWS.Amplify.StopJob",
  (
    app: App,
  ) => Effect.Effect<
    (request: StopJobRequest) => Effect.Effect<amplify.StopJobResult, amplify.StopJobError>
  >
> {}

export const StopJob = Binding.Service<StopJob>("AWS.Amplify.StopJob");

export const StopJobHttp = Layer.effect(
  StopJob,
  makeAmplifyHttpBinding({
    name: "StopJob",
    operation: amplify.stopJob,
    actions: ["amplify:StopJob"],
    resources: (app) => [Output.interpolate`${app.appArn}/branches/*/jobs/*`],
  }),
);
