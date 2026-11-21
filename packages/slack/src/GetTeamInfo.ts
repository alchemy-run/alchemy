import type * as Team from "@distilled.cloud/slack/team";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export type GetTeamInfoRequest = Team.TeamInfoRequest;

/**
 * Read the workspace's name, domain and icon (`team.info`). Workspace-wide: it binds to no resource.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.GetTeamInfoHttp` on the Worker or Function.
 *
 * Needs the bot scope `team:read`.
 *
 * ### Calling it at runtime
 * **Example:** Read the workspace's name, domain and icon
 * ```typescript
 * const teamInfo = yield* Slack.GetTeamInfo();
 * const { team } = yield* teamInfo({});
 * ```
 *
 * @binding
 * @product Team
 */
export interface GetTeamInfo extends Binding.Service<
  GetTeamInfo,
  "Slack.GetTeamInfo",
  () => Effect.Effect<
    (
      request: GetTeamInfoRequest,
    ) => Effect.Effect<Team.TeamInfoResponse, Team.TeamInfoError, RuntimeContext>
  >
> {}

export const GetTeamInfo = Binding.Service<GetTeamInfo>("Slack.GetTeamInfo");
