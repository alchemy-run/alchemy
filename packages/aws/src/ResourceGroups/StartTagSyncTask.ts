import * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Role } from "../IAM/Role.ts";
import type { Group } from "./Group.ts";

/**
 * Request for {@link StartTagSyncTask} — the group and (by default) the
 * bound role are injected from the binding; pass `RoleArn` to override.
 */
export type StartTagSyncTaskRequest = Omit<
  resourcegroups.StartTagSyncTaskInput,
  "Group" | "RoleArn"
> & { RoleArn?: string };

/**
 * Runtime binding for `resource-groups:StartTagSyncTask`.
 *
 * Starts a tag-sync task on the bound application {@link Group}: Resource
 * Groups continuously adds resources carrying the tag (or matching the
 * resource query) to the group and removes ones that stop matching, acting
 * as the bound IAM role. The binding grants the action on the group plus
 * `iam:PassRole` on the role (condition-scoped to
 * `resource-groups.amazonaws.com`); the role itself needs the tagging
 * permissions tag-sync uses and a trust policy for
 * `resource-groups.amazonaws.com`. Provide the implementation with
 * `Effect.provide(AWS.ResourceGroups.StartTagSyncTaskHttp)`.
 * ### Tag-Sync Tasks
 * **Example:** Keep A Group In Sync With A Tag
 * ```typescript
 * // init — bind the operation to the group and the sync role
 * const startTagSyncTask = yield* AWS.ResourceGroups.StartTagSyncTask(group, syncRole);
 *
 * // runtime
 * const { TaskArn } = yield* startTagSyncTask({
 *   TagKey: "team",
 *   TagValue: "platform",
 * });
 * ```
 *
 * @binding
 */
export interface StartTagSyncTask extends Binding.Service<
  StartTagSyncTask,
  "AWS.ResourceGroups.StartTagSyncTask",
  <R extends Role>(
    group: Group,
    syncRole: R,
  ) => Effect.Effect<
    (
      request: StartTagSyncTaskRequest,
    ) => Effect.Effect<resourcegroups.StartTagSyncTaskOutput, resourcegroups.StartTagSyncTaskError>
  >
> {}
export const StartTagSyncTask = Binding.Service<StartTagSyncTask>(
  "AWS.ResourceGroups.StartTagSyncTask",
);

// Bespoke (not on the shared scaffold): the only Resource Groups binding
// that passes an IAM role to the service, so it needs the second
// `iam:PassRole` statement and injects a default `RoleArn`.
export const StartTagSyncTaskHttp = Layer.effect(
  StartTagSyncTask,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const startTagSyncTask = yield* AWSBindings.withCredentials(resourcegroups.startTagSyncTask);

    return Effect.fn(function* <R extends Role>(group: Group, syncRole: R) {
      const GroupName = yield* group.groupName;
      const RoleArn = yield* syncRole.roleArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.ResourceGroups.StartTagSyncTask(${group}, ${syncRole})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["resource-groups:StartTagSyncTask"],
              Resource: [group.groupArn],
            },
            // Tag-sync maintains group membership, and the service
            // authorizes that as CreateGroup against the bare group
            // namespace (`arn:…:group/` — no name), which a specific
            // group ARN can never match. Scope to the namespace instead.
            {
              Effect: "Allow",
              Action: ["resource-groups:CreateGroup"],
              Resource: ["arn:aws:resource-groups:*:*:group/*"],
            },
            // CRITICAL: without iam:PassRole on the sync role,
            // StartTagSyncTask fails only at runtime with AccessDenied.
            {
              Effect: "Allow",
              Action: ["iam:PassRole"],
              Resource: [syncRole.roleArn],
              Condition: {
                StringEquals: {
                  "iam:PassedToService": "resource-groups.amazonaws.com",
                },
              },
            },
          ],
        });
      }
      return Effect.fn(`AWS.ResourceGroups.StartTagSyncTask(${group.LogicalId})`)(function* (
        request: StartTagSyncTaskRequest,
      ) {
        return yield* startTagSyncTask({
          ...request,
          Group: yield* GroupName,
          RoleArn: request.RoleArn ?? (yield* RoleArn),
        });
      });
    });
  }),
);
