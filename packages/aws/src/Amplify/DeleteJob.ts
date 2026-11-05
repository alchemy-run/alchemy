import * as amplify from "@distilled.cloud/aws/amplify";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { App } from "./App.ts";
import { makeAmplifyHttpBinding } from "./BindingHttp.ts";

export interface DeleteJobRequest extends Omit<amplify.DeleteJobRequest, "appId"> {}

/**
 * Runtime binding for `amplify:DeleteJob`.
 *
 * Bind an {@link App} in the function's init phase to get a callable that
 * deletes a build job from a branch's history — e.g. a maintenance function
 * pruning old build records. Provide the implementation with
 * `Effect.provide(AWS.Amplify.DeleteJobHttp)`.
 * ### Controlling Jobs
 * **Example:** Prune an Old Build Record
 * ```typescript
 * // init — bind the operation to the app
 * const deleteJob = yield* AWS.Amplify.DeleteJob(app);
 *
 * // runtime — remove the job from the branch's history
 * yield* deleteJob({ branchName: "main", jobId: "42" });
 * ```
 *
 * @binding
 */
export interface DeleteJob extends Binding.Service<
  DeleteJob,
  "AWS.Amplify.DeleteJob",
  (
    app: App,
  ) => Effect.Effect<
    (request: DeleteJobRequest) => Effect.Effect<amplify.DeleteJobResult, amplify.DeleteJobError>
  >
> {}

export const DeleteJob = Binding.Service<DeleteJob>("AWS.Amplify.DeleteJob");

export const DeleteJobHttp = Layer.effect(
  DeleteJob,
  makeAmplifyHttpBinding({
    name: "DeleteJob",
    operation: amplify.deleteJob,
    actions: ["amplify:DeleteJob"],
    resources: (app) => [Output.interpolate`${app.appArn}/branches/*/jobs/*`],
  }),
);
