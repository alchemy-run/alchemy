import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { App } from "../app.ts";
import * as Credentials from "distilled-aws/Credentials";
import * as STS from "distilled-aws/sts";

export class FailedToGetAccount extends Data.TaggedError(
  "AWS::Account::FailedToGetAccount",
)<{
  message: string;
  cause: Error;
}> {}

export type AccountID = string;

export class Account extends Context.Tag("AWS::AccountID")<
  Account,
  AccountID
>() {}

export class AWSStageConfigAccountMissing extends Data.TaggedError(
  "AWSStageConfigAccountMissing",
)<{
  message: string;
  stage: string;
}> {}

export const fromStageConfig = () =>
  Layer.effect(
    Account,
    Effect.gen(function* () {
      const app = yield* App;
      if (app.config.aws?.account) {
        return app.config.aws.account;
      }
      const profileName = app.config.aws?.profile;
      if (profileName) {
        const profile = yield* Credentials.loadProfile(profileName);
        if (profile.sso_account_id) {
          return profile.sso_account_id;
        }
      }
      const identity = yield* STS.getCallerIdentity({}).pipe(
        Effect.catchAll(
          (err) =>
            new FailedToGetAccount({
              message: "Failed to look up account ID",
              cause: err,
            }),
        ),
      );
      return identity.Account!;
    }),
  );
