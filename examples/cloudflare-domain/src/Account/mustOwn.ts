import * as Effect from "effect/Effect";
import { CurrentActor } from "../CurrentActor.ts";
import type { CustomerId } from "../Customer/CustomerId.ts";
import { NotOwner } from "./NotOwner.ts";

/**
 * Who may read an account's data: any agent, or the customer who owns the
 * account right now. An account that doesn't exist yet reads as empty, so a
 * client can watch for it to appear; someone else's is rejected.
 */
export const mustOwn = Effect.fn(function* (owner: CustomerId | null) {
  const actor = yield* CurrentActor;
  if (actor._tag === "Agent" || owner === null) return;
  if (actor._tag !== "Customer" || owner !== actor.customerId) return yield* new NotOwner();
});
