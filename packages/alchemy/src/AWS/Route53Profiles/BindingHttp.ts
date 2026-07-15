import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Profile } from "./Profile.ts";

/**
 * Shared scaffolding for Route 53 Profiles HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, makeProfilesHttpBinding({ … }))` over the builder
 * below. Everything except the operation, the IAM action list, and the grant
 * scope is boilerplate.
 */

/**
 * Build the impl Effect for a Route 53 Profiles operation scoped to a
 * {@link Profile}: the deploy-time half grants `actions` (on the bound
 * profile's ARN, or on `*` for list actions without resource-level
 * permission support), and the runtime half injects the profile's
 * `ProfileId` into every request.
 */
export const makeProfilesHttpBinding = <
  I extends { ProfileId?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Route53Profiles.ListProfileAssociations`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted by the binding. */
  actions: readonly string[];
  /**
   * Grant scope — `"profile"` scopes the grant to the bound Profile's ARN;
   * `"account"` grants on `*` (for list actions that do not support
   * resource-level permissions).
   */
  scope: "profile" | "account";
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (profile: Profile) {
      const ProfileId = yield* profile.profileId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${profile}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource:
                  options.scope === "profile" ? [profile.profileArn] : ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${profile.LogicalId})`)(function* (
        request?: Omit<I, "ProfileId">,
      ) {
        const profileId = yield* ProfileId;
        return yield* op({ ...request, ProfileId: profileId } as I);
      });
    });
  });
