import type * as Views from "@distilled.cloud/slack/views";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export type OpenViewRequest = Views.ViewsOpenRequest;

/**
 * Open a modal for a member, in answer to an interaction's `trigger_id` (`views.open`). Workspace-wide: it binds to no resource.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.OpenViewHttp` on the Worker or Function.
 *
 * ### Calling it at runtime
 * **Example:** Open a modal for a member, in answer to an interaction's `trigger_id`
 * ```typescript
 * const open = yield* Slack.OpenView();
 * yield* open({ trigger_id: payload.trigger_id, view: { type: "modal", title: { type: "plain_text", text: "Deploy" }, blocks: [] } });
 * ```
 *
 * @binding
 * @product View
 */
export interface OpenView extends Binding.Service<
  OpenView,
  "Slack.OpenView",
  () => Effect.Effect<
    (
      request: OpenViewRequest,
    ) => Effect.Effect<Views.ViewsOpenResponse, Views.ViewsOpenError, RuntimeContext>
  >
> {}

export const OpenView = Binding.Service<OpenView>("Slack.OpenView");
