import type * as Views from "@distilled.cloud/slack/views";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export type UpdateViewRequest = Views.UpdateViewRequest;

/**
 * Replace an open view's content (`views.update`). Workspace-wide: it binds to no resource.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.UpdateViewHttp` on the Worker or Function.
 *
 * ### Calling it at runtime
 * **Example:** Replace an open view's content
 * ```typescript
 * const update = yield* Slack.UpdateView();
 * yield* update({ view_id: payload.view.id, view });
 * ```
 *
 * @binding
 * @product View
 */
export interface UpdateView extends Binding.Service<
  UpdateView,
  "Slack.UpdateView",
  () => Effect.Effect<
    (
      request: UpdateViewRequest,
    ) => Effect.Effect<Views.UpdateViewResponse, Views.UpdateViewError, RuntimeContext>
  >
> {}

export const UpdateView = Binding.Service<UpdateView>("Slack.UpdateView");
