import type * as Users from "@distilled.cloud/slack/users";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export type GetUserPresenceRequest = Users.GetPresenceRequest;

/**
 * Read whether a member is active or away (`users.getPresence`). Workspace-wide: it binds to no resource.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.GetUserPresenceHttp` on the Worker or Function.
 *
 * Needs the bot scope `users:read`.
 *
 * ### Calling it at runtime
 * **Example:** Read whether a member is active or away
 * ```typescript
 * const presence = yield* Slack.GetUserPresence();
 * const { presence: state } = yield* presence({ user: "U0123456789" });
 * ```
 *
 * @binding
 * @product User
 */
export interface GetUserPresence extends Binding.Service<
  GetUserPresence,
  "Slack.GetUserPresence",
  () => Effect.Effect<
    (
      request: GetUserPresenceRequest,
    ) => Effect.Effect<Users.GetPresenceResponse, Users.GetPresenceError, RuntimeContext>
  >
> {}

export const GetUserPresence = Binding.Service<GetUserPresence>("Slack.GetUserPresence");
