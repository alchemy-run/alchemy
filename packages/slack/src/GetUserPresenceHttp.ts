import * as Users from "@distilled.cloud/slack/users";
import * as Layer from "effect/Layer";
import { makeWorkspaceBinding } from "./BindingHttp.ts";
import { GetUserPresence } from "./GetUserPresence.ts";

/**
 * Bot-token implementation of {@link GetUserPresence}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product User
 * @provides Slack.GetUserPresence
 */
export const GetUserPresenceHttp = Layer.effect(
  GetUserPresence,
  makeWorkspaceBinding({ name: "GetUserPresence", operation: Users.getPresence }),
);
