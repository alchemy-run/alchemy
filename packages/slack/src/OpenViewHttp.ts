import * as Views from "@distilled.cloud/slack/views";
import * as Layer from "effect/Layer";
import { makeWorkspaceBinding } from "./BindingHttp.ts";
import { OpenView } from "./OpenView.ts";

/**
 * Bot-token implementation of {@link OpenView}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product View
 * @provides Slack.OpenView
 */
export const OpenViewHttp = Layer.effect(
  OpenView,
  makeWorkspaceBinding({ name: "OpenView", operation: Views.viewsOpen }),
);
