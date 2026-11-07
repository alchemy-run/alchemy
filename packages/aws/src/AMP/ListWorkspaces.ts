import * as amp from "@distilled.cloud/aws/amp";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";

export interface ListWorkspacesRequest extends amp.ListWorkspacesRequest {}

/**
 * Runtime binding for `aps:ListWorkspaces`.
 *
 * An account-level binding — call it with no arguments to get a callable that
 * lists AMP workspaces in the region. Provide the `ListWorkspacesHttp` layer
 * on the Function to satisfy the binding.
 *
 * ### Workspace Metadata
 * **Example:** List Workspaces in the Region
 * ```typescript
 * const listWorkspaces = yield* AMP.ListWorkspaces();
 *
 * const response = yield* listWorkspaces();
 * const ids = response.workspaces.map((workspace) => workspace.workspaceId);
 * ```
 *
 * @binding
 */
export interface ListWorkspaces extends Binding.Service<
  ListWorkspaces,
  "AWS.AMP.ListWorkspaces",
  () => Effect.Effect<
    (
      request?: ListWorkspacesRequest,
    ) => Effect.Effect<amp.ListWorkspacesResponse, amp.ListWorkspacesError>
  >
> {}
export const ListWorkspaces = Binding.Service<ListWorkspaces>("AWS.AMP.ListWorkspaces");

export const ListWorkspacesHttp = Layer.effect(
  ListWorkspaces,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const listWorkspaces = yield* AWSBindings.withCredentials(amp.listWorkspaces);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.AMP.ListWorkspaces()`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["aps:ListWorkspaces"],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn("AWS.AMP.ListWorkspaces")(function* (request?: ListWorkspacesRequest) {
        return yield* listWorkspaces(request ?? {});
      });
    });
  }),
);
