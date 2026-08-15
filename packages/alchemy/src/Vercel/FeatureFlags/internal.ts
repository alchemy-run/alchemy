// Shared scaffolding for the FeatureFlags service — NOT exported from
// `FeatureFlags/index.ts` (generic helper names must not leak into the flat
// `Vercel` namespace).
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
