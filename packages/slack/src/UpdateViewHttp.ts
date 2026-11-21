import * as Views from "@distilled.cloud/slack/views";
import * as Layer from "effect/Layer";
import { makeWorkspaceBinding } from "./BindingHttp.ts";
import { UpdateView } from "./UpdateView.ts";

/**
 * Bot-token implementation of {@link UpdateView}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product View
 * @provides Slack.UpdateView
 */
export const UpdateViewHttp = Layer.effect(
  UpdateView,
  makeWorkspaceBinding({ name: "UpdateView", operation: Views.updateView }),
);
