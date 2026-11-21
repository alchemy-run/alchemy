import type * as Users from "@distilled.cloud/slack/users";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export type LookupUserByEmailRequest = Users.LookupByEmailRequest;

/**
 * Find a member by email address (`users.lookupByEmail`). Workspace-wide: it binds to no resource.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.LookupUserByEmailHttp` on the Worker or Function.
 *
 * Needs the bot scope `users:read.email`.
 *
 * ### Calling it at runtime
 * **Example:** Find a member by email address
 * ```typescript
 * const lookup = yield* Slack.LookupUserByEmail();
 * const { user } = yield* lookup({ email: "alice@example.com" });
 * ```
 *
 * @binding
 * @product User
 */
export interface LookupUserByEmail extends Binding.Service<
  LookupUserByEmail,
  "Slack.LookupUserByEmail",
  () => Effect.Effect<
    (
      request: LookupUserByEmailRequest,
    ) => Effect.Effect<Users.LookupByEmailResponse, Users.LookupByEmailError, RuntimeContext>
  >
> {}

export const LookupUserByEmail = Binding.Service<LookupUserByEmail>("Slack.LookupUserByEmail");
