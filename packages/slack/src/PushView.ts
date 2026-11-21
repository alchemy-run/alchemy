import type * as Views from "@distilled.cloud/slack/views";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export type PushViewRequest = Views.ViewsPushRequest;

/**
 * Push a view onto an open modal's stack (`views.push`). Workspace-wide: it binds to no resource.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.PushViewHttp` on the Worker or Function.
 *
 * ### Calling it at runtime
 * **Example:** Push a view onto an open modal's stack
 * ```typescript
 * const push = yield* Slack.PushView();
 * yield* push({ trigger_id: payload.trigger_id, view });
 * ```
 *
 * @binding
 * @product View
 */
export interface PushView extends Binding.Service<
  PushView,
  "Slack.PushView",
  () => Effect.Effect<
    (
      request: PushViewRequest,
    ) => Effect.Effect<Views.ViewsPushResponse, Views.ViewsPushError, RuntimeContext>
  >
> {}

export const PushView = Binding.Service<PushView>("Slack.PushView");
