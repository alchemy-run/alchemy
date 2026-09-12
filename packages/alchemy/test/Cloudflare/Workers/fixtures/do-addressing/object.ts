import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * A Durable Object with per-instance state, used to prove *which* instance a
 * given addressing route reached.
 *
 * `bump` returns the instance's own count, so two routes that reach the same
 * instance see one shared, monotonic counter, and two routes that reach
 * different instances each see their own. That is the only way to tell
 * `get(idFromName("x"))` and `getByName("x")` apart from the outside — both
 * answer, but only one identity is correct.
 */
export class AddressingObject extends Cloudflare.DurableObject<AddressingObject>()(
  "AddressingObject",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      return {
        bump: () =>
          Effect.gen(function* () {
            const count =
              ((yield* state.storage.get<number>("count")) ?? 0) + 1;
            yield* state.storage.put("count", count);
            return count;
          }),
      };
    });
  }),
) {}
