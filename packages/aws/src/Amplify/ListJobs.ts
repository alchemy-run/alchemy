import * as amplify from "@distilled.cloud/aws/amplify";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { App } from "./App.ts";
import { makeAmplifyHttpBinding } from "./BindingHttp.ts";

export interface ListJobsRequest extends Omit<amplify.ListJobsRequest, "appId"> {}

/**
 * Runtime binding for `amplify:ListJobs`.
 *
 * Bind an {@link App} in the function's init phase to get a callable that
 * lists the build jobs of one of the app's branches, newest first. Provide the
 * implementation with `Effect.provide(AWS.Amplify.ListJobsHttp)`.
 * ### Observing Jobs
 * **Example:** Read the Latest Job of a Branch
 * ```typescript
 * // init — bind the operation to the app
 * const listJobs = yield* AWS.Amplify.ListJobs(app);
 *
 * // runtime — the first summary is the most recent job
 * const { jobSummaries } = yield* listJobs({
 *   branchName: "main",
 *   maxResults: 1,
 * });
 * const latest = jobSummaries[0];
 * ```
 *
 * @binding
 */
export interface ListJobs extends Binding.Service<
  ListJobs,
  "AWS.Amplify.ListJobs",
  (
    app: App,
  ) => Effect.Effect<
    (request: ListJobsRequest) => Effect.Effect<amplify.ListJobsResult, amplify.ListJobsError>
  >
> {}

export const ListJobs = Binding.Service<ListJobs>("AWS.Amplify.ListJobs");

export const ListJobsHttp = Layer.effect(
  ListJobs,
  makeAmplifyHttpBinding({
    name: "ListJobs",
    operation: amplify.listJobs,
    actions: ["amplify:ListJobs"],
    resources: (app) => [Output.interpolate`${app.appArn}/branches/*/jobs/*`],
  }),
);
