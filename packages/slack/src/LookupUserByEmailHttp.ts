import * as Users from "@distilled.cloud/slack/users";
import * as Layer from "effect/Layer";
import { makeWorkspaceBinding } from "./BindingHttp.ts";
import { LookupUserByEmail } from "./LookupUserByEmail.ts";

/**
 * Bot-token implementation of {@link LookupUserByEmail}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product User
 * @provides Slack.LookupUserByEmail
 */
export const LookupUserByEmailHttp = Layer.effect(
  LookupUserByEmail,
  makeWorkspaceBinding({ name: "LookupUserByEmail", operation: Users.lookupByEmail }),
);
