import type * as SVC from "@distilled.cloud/aws/codedeploy";
import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

export interface CreateDeploymentRequest extends Omit<
  SVC.CreateDeploymentInput,
  "applicationName" | "deploymentGroupName"
> {}

/**
 * Runtime binding for `codedeploy:CreateDeployment` — lets a workload start
 * a deployment through the bound deployment group (e.g. shifting a Lambda
 * alias or rolling an EC2 fleet to a new revision).
 *
 * The response carries the created `deploymentId`, which can be observed
 * with the {@link GetDeployment} binding.
 * ### Starting Deployments
 * **Example:** Deploy a Registered Revision
 * ```typescript
 * const createDeployment = yield* AWS.CodeDeploy.CreateDeployment(group);
 *
 * const { deploymentId } = yield* createDeployment({
 *   revision: {
 *     revisionType: "S3",
 *     s3Location: { bucket, key, bundleType: "zip" },
 *   },
 * });
 * ```
 *
 * @binding
 */
export interface CreateDeployment extends Binding.Service<
  CreateDeployment,
  "AWS.CodeDeploy.CreateDeployment",
  <G extends DeploymentGroup>(
    group: G,
  ) => Effect.Effect<
    (
      request?: CreateDeploymentRequest,
    ) => Effect.Effect<SVC.CreateDeploymentOutput, SVC.CreateDeploymentError>
  >
> {}
export const CreateDeployment = Binding.Service<CreateDeployment>(
  "AWS.CodeDeploy.CreateDeployment",
);

/**
 * Bespoke (multi-statement IAM): besides `codedeploy:CreateDeployment` on
 * the group, creating a deployment reads the deployment configuration and
 * the application revision on the caller's behalf, so the grant also covers
 * `GetDeploymentConfig` on the account's configs and
 * `GetApplicationRevision`/`RegisterApplicationRevision` on the group's
 * application.
 */
export const CreateDeploymentHttp = Layer.effect(
  CreateDeployment,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(codedeploy.createDeployment);

    return Effect.fn(function* <G extends DeploymentGroup>(group: G) {
      // Outputs yield a DEFERRED effect — resolve again per invocation below.
      const ApplicationName = yield* group.applicationName;
      const DeploymentGroupName = yield* group.deploymentGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.CodeDeploy.CreateDeployment(${group})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["codedeploy:CreateDeployment"],
              Resource: [Output.interpolate`${group.deploymentGroupArn}`],
            },
            {
              Effect: "Allow",
              Action: ["codedeploy:GetDeploymentConfig"],
              Resource: [
                Output.map(group.deploymentGroupArn, (arn) =>
                  arn.replace(/:deploymentgroup:.*$/, ":deploymentconfig:*"),
                ),
              ],
            },
            {
              Effect: "Allow",
              Action: [
                "codedeploy:GetApplicationRevision",
                "codedeploy:RegisterApplicationRevision",
              ],
              Resource: [
                Output.map(group.deploymentGroupArn, (arn) =>
                  arn.replace(/:deploymentgroup:([^/]+)\/.*$/, ":application:$1"),
                ),
              ],
            },
          ],
        });
      }
      return Effect.fn(`AWS.CodeDeploy.CreateDeployment(${group.LogicalId})`)(function* (
        request?: CreateDeploymentRequest,
      ) {
        return yield* op({
          ...request,
          applicationName: yield* ApplicationName,
          deploymentGroupName: yield* DeploymentGroupName,
        });
      });
    });
  }),
);
