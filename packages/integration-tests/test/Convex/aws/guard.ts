import * as sts from "@distilled.cloud/aws/sts";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * The AWS account no test may ever run in, such as your production account.
 * Unset, only an account AWS can't name is refused.
 */
export const PRODUCTION_ACCOUNT = Config.option(
  Config.String("CONVEX_TEST_PRODUCTION_AWS_ACCOUNT"),
);

export class WrongAccount extends Data.TaggedError("WrongAccount")<{
  readonly message: string;
}> {}

/** Refuses the production account, whatever the profile says. */
export const refuseProduction = (account: string | undefined, production: Option.Option<string>) =>
  account === undefined || Option.contains(production, account)
    ? Effect.fail(new WrongAccount({ message: `Refusing to run in AWS account ${account}.` }))
    : Effect.void;

/** Ask AWS which account this run is in, and refuse production. */
export const assertDevAccount = Effect.gen(function* () {
  const production = yield* PRODUCTION_ACCOUNT;
  const { Account } = yield* sts.getCallerIdentity({});
  return yield* refuseProduction(Account, production);
});
