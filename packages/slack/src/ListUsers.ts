import type * as Users from "@distilled.cloud/slack/users";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export type ListUsersRequest = Users.ListUsersRequest;

/**
 * List the workspace's members (`users.list`). Workspace-wide: it binds to no resource.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.ListUsersHttp` on the Worker or Function.
 *
 * Needs the bot scope `users:read`.
 *
 * ### Calling it at runtime
 * **Example:** List the workspace's members
 * ```typescript
 * const listUsers = yield* Slack.ListUsers();
 * const { members } = yield* listUsers({ limit: 200 });
 * ```
 *
 * @binding
 * @product User
 */
export interface ListUsers extends Binding.Service<
  ListUsers,
  "Slack.ListUsers",
  () => Effect.Effect<
    (
      request: ListUsersRequest,
    ) => Effect.Effect<Users.ListUsersResponse, Users.ListUsersError, RuntimeContext>
  >
> {}

export const ListUsers = Binding.Service<ListUsers>("Slack.ListUsers");
