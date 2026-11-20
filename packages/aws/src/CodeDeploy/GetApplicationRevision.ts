import type * as SVC from "@distilled.cloud/aws/codedeploy";
import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Application } from "./Application.ts";
import { makeCodeDeployApplicationHttpBinding } from "./BindingHttp.ts";

export interface GetApplicationRevisionRequest extends Omit<
  SVC.GetApplicationRevisionInput,
  "applicationName"
> {}

/**
 * Runtime binding for `codedeploy:GetApplicationRevision` — reads a
 * registered revision's metadata (description, deployment groups it was
 * deployed to, first-seen time).
 * ### Managing Revisions
 * **Example:** Read a Revision
 * ```typescript
 * const getApplicationRevision =
 *   yield* AWS.CodeDeploy.GetApplicationRevision(app);
 *
 * const { revisionInfo } = yield* getApplicationRevision({
 *   revision: {
 *     revisionType: "S3",
 *     s3Location: { bucket, key, bundleType: "zip" },
 *   },
 * });
 * ```
 *
 * @binding
 */
export interface GetApplicationRevision extends Binding.Service<
  GetApplicationRevision,
  "AWS.CodeDeploy.GetApplicationRevision",
  <P extends Application>(
    application: P,
  ) => Effect.Effect<
    (
      request: GetApplicationRevisionRequest,
    ) => Effect.Effect<SVC.GetApplicationRevisionOutput, SVC.GetApplicationRevisionError>
  >
> {}
export const GetApplicationRevision = Binding.Service<GetApplicationRevision>(
  "AWS.CodeDeploy.GetApplicationRevision",
);

export const GetApplicationRevisionHttp = Layer.effect(
  GetApplicationRevision,
  makeCodeDeployApplicationHttpBinding({
    tag: "AWS.CodeDeploy.GetApplicationRevision",
    operation: codedeploy.getApplicationRevision,
    actions: ["codedeploy:GetApplicationRevision"],
  }),
);
