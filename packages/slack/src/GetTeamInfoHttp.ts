import * as Team from "@distilled.cloud/slack/team";
import * as Layer from "effect/Layer";
import { makeWorkspaceBinding } from "./BindingHttp.ts";
import { GetTeamInfo } from "./GetTeamInfo.ts";

/**
 * Bot-token implementation of {@link GetTeamInfo}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Team
 * @provides Slack.GetTeamInfo
 */
export const GetTeamInfoHttp = Layer.effect(
  GetTeamInfo,
  makeWorkspaceBinding({ name: "GetTeamInfo", operation: Team.teamInfo }),
);
