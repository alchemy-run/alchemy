// Shared scaffolding for the AccessGroups service — NOT exported from
// `AccessGroups/index.ts` (generic helper names must not leak into the flat
// `Vercel` namespace).
import * as accessGroups from "@distilled.cloud/vercel/access_groups";
import * as Effect from "effect/Effect";
import { VercelEnvironment } from "../VercelEnvironment.ts";

/**
 * Vercel scopes team requests via a per-op `teamId` query parameter, resolved
 * INSIDE lifecycle operations and omitted entirely when undefined (personal
 * scope).
 */
export const teamScope: Effect.Effect<
  { teamId?: string },
  never,
  VercelEnvironment
> = Effect.gen(function* () {
  const { teamId } = yield* VercelEnvironment.current;
  return teamId === undefined ? {} : { teamId };
});

/**
 * Exhaustively enumerate every access group in the team/account scope.
 * Shared by both providers' `list` fan-outs.
 */
export const listAllAccessGroups = (scope: { teamId?: string }) =>
  Effect.gen(function* () {
    const groups: accessGroups.ListAccessGroupsResponse["accessGroups"][number][] =
      [];
    let next: string | undefined;
    do {
      const page = yield* accessGroups.listAccessGroups({
        limit: 100,
        ...(next !== undefined ? { next } : {}),
        ...scope,
      });
      groups.push(...page.accessGroups);
      next = page.pagination.next ?? undefined;
    } while (next !== undefined);
    return groups;
  });
