import * as Views from "@distilled.cloud/slack/views";
import * as Layer from "effect/Layer";
import { makeWorkspaceBinding } from "./BindingHttp.ts";
import { PushView } from "./PushView.ts";

/**
 * Bot-token implementation of {@link PushView}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product View
 * @provides Slack.PushView
 */
export const PushViewHttp = Layer.effect(
  PushView,
  makeWorkspaceBinding({ name: "PushView", operation: Views.viewsPush }),
);
