import type * as Views from "@distilled.cloud/slack/views";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export type PublishViewRequest = Views.PublishViewRequest;

/**
 * Publish a member's App Home tab (`views.publish`). Workspace-wide: it binds to no resource.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.PublishViewHttp` on the Worker or Function.
 *
 * ### Calling it at runtime
 * **Example:** Publish a member's App Home tab
 * ```typescript
 * const publish = yield* Slack.PublishView();
 * yield* publish({ user_id: event.user, view: { type: "home", blocks: [] } });
 * ```
 *
 * @binding
 * @product View
 */
export interface PublishView extends Binding.Service<
  PublishView,
  "Slack.PublishView",
  () => Effect.Effect<
    (
      request: PublishViewRequest,
    ) => Effect.Effect<Views.PublishViewResponse, Views.PublishViewError, RuntimeContext>
  >
> {}

export const PublishView = Binding.Service<PublishView>("Slack.PublishView");
