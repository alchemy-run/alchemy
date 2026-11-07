import * as amp from "@distilled.cloud/aws/amp";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Runtime binding for `aps:DescribeWorkspace`.
 *
 * Bind this operation to a {@link Workspace} inside a function runtime to get
 * a callable that reads the workspace's control-plane metadata (status,
 * alias, endpoint). Provide the `DescribeWorkspaceHttp` layer on the Function
 * to satisfy the binding.
 *
 * ### Workspace Metadata
 * **Example:** Describe the Bound Workspace
 * ```typescript
 * const describeWorkspace = yield* AMP.DescribeWorkspace(workspace);
 *
 * const response = yield* describeWorkspace();
 * const status = response.workspace.status.statusCode;
 * ```
 *
 * @binding
 */
export interface DescribeWorkspace extends Binding.Service<
  DescribeWorkspace,
  "AWS.AMP.DescribeWorkspace",
  (
    workspace: Workspace,
  ) => Effect.Effect<() => Effect.Effect<amp.DescribeWorkspaceResponse, amp.DescribeWorkspaceError>>
> {}
export const DescribeWorkspace = Binding.Service<DescribeWorkspace>("AWS.AMP.DescribeWorkspace");

export const DescribeWorkspaceHttp = Layer.effect(
  DescribeWorkspace,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const describeWorkspace = yield* AWSBindings.withCredentials(amp.describeWorkspace);

    return Effect.fn(function* (workspace: Workspace) {
      const WorkspaceId = yield* workspace.workspaceId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.AMP.DescribeWorkspace(${workspace})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["aps:DescribeWorkspace"],
              Resource: [workspace.workspaceArn],
            },
          ],
        });
      }
      return Effect.fn(`AWS.AMP.DescribeWorkspace(${workspace.LogicalId})`)(function* () {
        return yield* describeWorkspace({
          workspaceId: yield* WorkspaceId,
        });
      });
    });
  }),
);
