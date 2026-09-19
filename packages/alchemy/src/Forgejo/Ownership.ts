import * as Effect from "effect/Effect";
import { OwnedBySomeoneElse, Unowned } from "../AdoptPolicy.ts";

/** A name match is discovery, not ownership evidence. */
export const discovered = <A extends object>(
  attributes: A,
  owned: boolean,
): A => (owned ? attributes : Unowned(attributes));

/** Race winners must go through the engine's read/adoption gate on a new plan. */
export const requireOwnership = (owned: boolean, physicalName: string) =>
  owned
    ? Effect.void
    : Effect.fail(
        new OwnedBySomeoneElse({
          physicalName,
          message: `Forgejo resource '${physicalName}' exists without matching saved ownership. Re-plan with explicit adoption to take it over.`,
        }),
      );
