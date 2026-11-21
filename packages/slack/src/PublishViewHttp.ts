import * as Views from "@distilled.cloud/slack/views";
import * as Layer from "effect/Layer";
import { makeWorkspaceBinding } from "./BindingHttp.ts";
import { PublishView } from "./PublishView.ts";

/**
 * Bot-token implementation of {@link PublishView}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product View
 * @provides Slack.PublishView
 */
export const PublishViewHttp = Layer.effect(
  PublishView,
  makeWorkspaceBinding({ name: "PublishView", operation: Views.publishView }),
);
