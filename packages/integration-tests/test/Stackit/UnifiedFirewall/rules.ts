import { expect } from "@alchemy.run/test";
import * as ufw from "@distilled.cloud/stackit/ufw";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export interface Scope {
  readonly projectId: string;
  readonly region: string;
}

const target = (scope: Scope) => ({ projectId: scope.projectId, regionId: scope.region });

export class NoSecurityRuleProduct extends Data.TaggedError("NoSecurityRuleProduct")<{
  readonly message: string;
}> {}

/**
 * The product a security group rule names. The spec gives none for security groups, so it comes
 * from the region's own options. A security group is free, which is why these suites are ungated.
 */
export const securityRuleProduct = (region: string) =>
  Effect.gen(function* () {
    const { productMeta, products } = yield* ufw.listProviderOptions({ regionId: region });
    const product = products.find((name) => productMeta[name]?.types.includes("SecurityRule"));
    if (product === undefined) {
      return yield* new NoSecurityRuleProduct({
        message: `no product in ${region} takes SecurityRule rules`,
      });
    }
    return product;
  });

/** Bounded wait until a rule made out of band is `Active`. */
export const waitForActive = (scope: Scope, ruleId: string) =>
  ufw.getRule({ ...target(scope), ruleId }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (rule) => rule.status === "Active" || rule.status === "Error",
      times: 30,
    }),
  );

/** Bounded check that a rule reads as gone. */
export const expectRuleGone = (scope: Scope, ruleId: string) =>
  ufw.getRule({ ...target(scope), ruleId }).pipe(
    Effect.map(() => "present" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (state) => state === "gone",
      times: 30,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );

/** Delete a rule the test made out of band, for an `Effect.ensuring`. */
export const deleteOutOfBand = (scope: Scope, ruleId: string) =>
  ufw.deleteRule({ ...target(scope), ruleId }).pipe(Effect.ignore);
