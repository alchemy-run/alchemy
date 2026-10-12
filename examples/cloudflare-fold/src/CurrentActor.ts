import { Command } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import { Actor } from "./Actor.ts";

/**
 * Who is making the current request. The session middleware provides it;
 * commands read it in `decide`, and senders without a session (policies)
 * provide it themselves.
 */
export class CurrentActor extends Command.Context<CurrentActor>()("Bank/CurrentActor", Actor) {}

/** The signed-in customer's id, for reads behind `CustomerSession`. */
export const currentCustomerId = Effect.gen(function* () {
  const actor = yield* CurrentActor;
  if (actor._tag !== "Customer") {
    return yield* Effect.die(new Error(`expected a customer session, got ${actor._tag}`));
  }
  return actor.customerId;
});
