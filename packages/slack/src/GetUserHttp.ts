import * as Users from "@distilled.cloud/slack/users";
import * as Layer from "effect/Layer";
import { makeWorkspaceBinding } from "./BindingHttp.ts";
import { GetUser } from "./GetUser.ts";

/**
 * Bot-token implementation of {@link GetUser}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product User
 * @provides Slack.GetUser
 */
export const GetUserHttp = Layer.effect(
  GetUser,
  makeWorkspaceBinding({ name: "GetUser", operation: Users.usersInfo }),
);
