import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostAccess from "../HostAccess.ts";
import { BatchGetDeployments } from "./BatchGetDeployments.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

/**
 * Bespoke IAM: `codedeploy:BatchGetDeployments` does not support
 * resource-level permissions (a batch of deployment ids cannot be mapped to
 * a deployment-group resource before authorization), so the grant must be
 * on `*` — a group-scoped grant is denied with AccessDeniedException.
 */
export const BatchGetDeploymentsHttp = Layer.effect(
  BatchGetDeployments,
  Effect.gen(function* () {
    const op = yield* HostAccess.withCredentials(codedeploy.batchGetDeployments);

    return Effect.fn(function* <G extends DeploymentGroup>(group: G) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* HostAccess.bind`AWS.CodeDeploy.BatchGetDeployments(${group})`({
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
