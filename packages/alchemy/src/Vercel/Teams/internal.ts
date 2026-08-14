// Shared scaffolding for the Teams service — NOT exported from
// `Teams/index.ts` (generic helper names must not leak into the flat
// `Vercel` namespace).
import * as teams from "@distilled.cloud/vercel/teams";
import * as user from "@distilled.cloud/vercel/user";
import * as Effect from "effect/Effect";
import { VercelEnvironment } from "../VercelEnvironment.ts";

/**
 * Resolve the team the token operates in: the ambient `VercelEnvironment`
 * scope when set, otherwise the authenticated user's default team (on
 * northstar accounts every token has one — "personal scope" requests
 * actually land on it). Dies when neither exists: team-scoped operations
 * (members, team settings) have no meaning without a team.
 */
export const resolveTeamId = Effect.gen(function* () {
  const { teamId } = yield* VercelEnvironment.current;
  if (teamId !== undefined) return teamId;
  const auth = yield* user.getAuthUser({}).pipe(Effect.orDie);
  const defaultTeamId = auth.user.defaultTeamId;
  if (defaultTeamId === null || defaultTeamId === undefined) {
    return yield* Effect.die(
      "Vercel team-scoped operation requires a team: set VERCEL_TEAM_ID or use a token whose user has a default team",
    );
  }
  return defaultTeamId;
});

/**
 * Exhaustively enumerate every member of the given team. Shared by the
 * TeamMember provider's observe step and `list` fan-out.
 */
export const listAllTeamMembers = (teamId: string, search?: string) =>
  Effect.gen(function* () {
    const members: teams.GetTeamMembersResponse["members"][number][] = [];
    let until: number | undefined;
    let hasNext = true;
    while (hasNext) {
      const page = yield* teams.getTeamMembers({
        teamId,
        limit: 100,
        ...(search !== undefined ? { search } : {}),
        ...(until !== undefined ? { until } : {}),
      });
      members.push(...page.members);
      hasNext = page.pagination.hasNext;
      // The members feed pages by createdAt timestamp cursors.
      until =
        typeof page.pagination.next === "number"
          ? page.pagination.next
          : undefined;
      if (until === undefined) hasNext = false;
    }
    return members;
  });
