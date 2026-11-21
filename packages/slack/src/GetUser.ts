import type * as Users from "@distilled.cloud/slack/users";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export type GetUserRequest = Users.UsersInfoRequest;

/**
 * Read a member's profile (`users.info`). Workspace-wide: it binds to no resource.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.GetUserHttp` on the Worker or Function.
 *
 * Needs the bot scope `users:read`.
 *
 * ### Calling it at runtime
 * **Example:** Read a member's profile
 * ```typescript
 * const getUser = yield* Slack.GetUser();
 * const { user } = yield* getUser({ user: "U0123456789" });
 * ```
 *
 * @binding
 * @product User
 */
export interface GetUser extends Binding.Service<
  GetUser,
  "Slack.GetUser",
  () => Effect.Effect<
    (
      request: GetUserRequest,
    ) => Effect.Effect<Users.UsersInfoResponse, Users.UsersInfoError, RuntimeContext>
  >
> {}

export const GetUser = Binding.Service<GetUser>("Slack.GetUser");
