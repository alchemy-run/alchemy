import * as Users from "@distilled.cloud/slack/users";
import * as Layer from "effect/Layer";
import { makeWorkspaceBinding } from "./BindingHttp.ts";
import { ListUsers } from "./ListUsers.ts";

/**
 * Bot-token implementation of {@link ListUsers}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product User
 * @provides Slack.ListUsers
 */
export const ListUsersHttp = Layer.effect(
  ListUsers,
  makeWorkspaceBinding({ name: "ListUsers", operation: Users.listUsers }),
);
