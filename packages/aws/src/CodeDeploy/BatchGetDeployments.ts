import type * as SVC from "@distilled.cloud/aws/codedeploy";
import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

/**
 * Runtime binding for `codedeploy:BatchGetDeployments` — reads up to 25
 * deployments in one call. CodeDeploy authorizes the call against the
 * deployment group the deployments belong to.
 * ### Observing Deployments
 * **Example:** Read Several Deployments
 * ```typescript
 * const batchGetDeployments = yield* AWS.CodeDeploy.BatchGetDeployments(group);
 *
 * const { deploymentsInfo } = yield* batchGetDeployments({
 *   deploymentIds: ["d-ABCDEF123", "d-GHIJKL456"],
 * });
 * ```
 *
 * @binding
 */
export interface BatchGetDeployments extends Binding.Service<
  BatchGetDeployments,
  "AWS.CodeDeploy.BatchGetDeployments",
  <G extends DeploymentGroup>(
    group: G,
  ) => Effect.Effect<
    (
      request: SVC.BatchGetDeploymentsInput,
    ) => Effect.Effect<SVC.BatchGetDeploymentsOutput, SVC.BatchGetDeploymentsError>
  >
> {}
export const BatchGetDeployments = Binding.Service<BatchGetDeployments>(
  "AWS.CodeDeploy.BatchGetDeployments",
);

/**
 * Bespoke IAM: `codedeploy:BatchGetDeployments` does not support
 * resource-level permissions (a batch of deployment ids cannot be mapped to
 * a deployment-group resource before authorization), so the grant must be
 * on `*` — a group-scoped grant is denied with AccessDeniedException.
 */
export const BatchGetDeploymentsHttp = Layer.effect(
  BatchGetDeployments,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(codedeploy.batchGetDeployments);

    return Effect.fn(function* <G extends DeploymentGroup>(group: G) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.CodeDeploy.BatchGetDeployments(${group})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["codedeploy:BatchGetDeployments"],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn(`AWS.CodeDeploy.BatchGetDeployments(${group.LogicalId})`)(function* (
        request: codedeploy.BatchGetDeploymentsInput,
      ) {
        return yield* op(request);
      });
    });
  }),
);
