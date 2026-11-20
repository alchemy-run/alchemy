import * as amplify from "@distilled.cloud/aws/amplify";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { App } from "./App.ts";

export interface GetArtifactUrlRequest extends amplify.GetArtifactUrlRequest {}

/**
 * Runtime binding for `amplify:GetArtifactUrl`.
 *
 * Bind an {@link App} in the function's init phase to get a callable that
 * resolves a pre-signed download URL for a build artifact discovered via
 * {@link ListArtifacts}. Provide the implementation with
 * `Effect.provide(AWS.Amplify.GetArtifactUrlHttp)`.
 * ### Reading Artifacts
 * **Example:** Download a Job Artifact
 * ```typescript
 * // init — bind the operation to the app
 * const listArtifacts = yield* AWS.Amplify.ListArtifacts(app);
 * const getArtifactUrl = yield* AWS.Amplify.GetArtifactUrl(app);
 *
 * // runtime — resolve a pre-signed URL for the first artifact
 * const { artifacts } = yield* listArtifacts({
 *   branchName: "main",
 *   jobId: "42",
 * });
 * const { artifactUrl } = yield* getArtifactUrl({
 *   artifactId: artifacts[0].artifactId,
 * });
 * ```
 *
 * @binding
 */
export interface GetArtifactUrl extends Binding.Service<
  GetArtifactUrl,
  "AWS.Amplify.GetArtifactUrl",
  (
    app: App,
  ) => Effect.Effect<
    (
      request: GetArtifactUrlRequest,
    ) => Effect.Effect<amplify.GetArtifactUrlResult, amplify.GetArtifactUrlError>
  >
> {}

export const GetArtifactUrl = Binding.Service<GetArtifactUrl>("AWS.Amplify.GetArtifactUrl");

// Bespoke (not via makeAmplifyHttpBinding): GetArtifactUrl addresses the
// artifact by its globally-unique `artifactId` alone — there is no `appId`
// to inject. The app is still bound for the IAM grant over its artifacts.
export const GetArtifactUrlHttp = Layer.effect(
  GetArtifactUrl,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const getArtifactUrl = yield* AWSBindings.withCredentials(amplify.getArtifactUrl);

    return Effect.fn(function* (app: App) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Amplify.GetArtifactUrl(${app})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["amplify:GetArtifactUrl"],
              Resource: [Output.interpolate`${app.appArn}/branches/*/jobs/*/artifacts/*`],
            },
          ],
        });
      }
      return Effect.fn(`AWS.Amplify.GetArtifactUrl(${app.LogicalId})`)(function* (
        request: GetArtifactUrlRequest,
      ) {
        return yield* getArtifactUrl(request);
      });
    });
  }),
);
