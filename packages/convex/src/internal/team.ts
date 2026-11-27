import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { team } from "../Credentials.ts";

/** The resource belongs to a team the current token isn't for. */
export class WrongTeam extends Data.TaggedError("WrongTeam")<{
  readonly message: string;
}> {}

/**
 * Convex answers 404 for anything the token can't see, so a token from another
 * team would read as "already gone": the state row would drop and the resource
 * leak. Call this before a delete treats a not-found as success.
 */
export const assertTeam = Effect.fn(function* (teamId: number, what: string) {
  const current = yield* team;
  if (current !== teamId) {
    return yield* new WrongTeam({
      message: `Convex: ${what} belongs to team ${teamId}, but the token is for team ${current}.`,
    });
  }
});
