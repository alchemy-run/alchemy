import * as sts from "@distilled.cloud/aws/sts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** The production account. No test may ever run here. */
export const PRODUCTION_ACCOUNT = "807128272793";

export class WrongAccount extends Data.TaggedError("WrongAccount")<{
  readonly message: string;
}> {}

/** Refuses a production account, whatever the profile says. */
export const refuseProduction = (account: string | undefined) =>
  account === undefined || account === PRODUCTION_ACCOUNT
    ? Effect.fail(new WrongAccount({ message: `Refusing to run in AWS account ${account}.` }))
    : Effect.void;

/** Ask AWS which account this run is in, and refuse production. */
export const assertDevAccount = sts
  .getCallerIdentity({})
  .pipe(Effect.flatMap(({ Account }) => refuseProduction(Account)));
