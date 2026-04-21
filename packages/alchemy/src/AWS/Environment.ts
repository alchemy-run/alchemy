import * as Auth from "@distilled.cloud/aws/Auth";
import {
  fromAwsCredentialIdentity,
  type CredentialsError,
  type ResolvedCredentials,
} from "@distilled.cloud/aws/Credentials";
import type { AwsCredentialIdentity } from "@smithy/types";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export const AWS_PROFILE = Config.string("AWS_PROFILE").pipe(
  Config.withDefault("default"),
);

export const AWS_REGION = Config.string("AWS_REGION");

export type AccountID = string;
export type RegionID = string;

export class FailedToGetAccount extends Data.TaggedError(
  "AWS::Environment::FailedToGetAccount",
)<{
  message: string;
  cause: Error;
}> {}

/**
 * Fully-resolved AWS environment for a stack. Mirrors `CloudflareEnvironment`:
 * one Context.Service that holds account, region, credentials, endpoint, and
 * (optionally) the SSO profile name.
 *
 * `credentials` is held as an Effect so callers can refresh on each access
 * (SSO sessions expire). The Effect itself is constructed once when this
 * service is built; resolving it lazily preserves @distilled.cloud/aws's
 * existing `Credentials` semantics.
 */
export interface AWSEnvironmentShape {
  accountId: AccountID;
  region: RegionID;
  credentials: Effect.Effect<ResolvedCredentials, CredentialsError>;
  endpoint?: string;
  profile?: string;
}

export class AWSEnvironment extends Context.Service<
  AWSEnvironment,
  AWSEnvironmentShape
>()("AWS::Environment") {}

/**
 * Build an `AWSEnvironment` from an SSO profile (`AWS_PROFILE` env var,
 * defaults to `"default"`). Uses the profile's `sso_account_id` and `region`,
 * and resolves credentials lazily via `aws sso login`.
 */
export const Default = Layer.effect(
  AWSEnvironment,
  Effect.suspend(() => loadDefault()),
).pipe(Layer.orDie);

export const loadDefault = () =>
  Effect.gen(function* () {
    const profileName = yield* AWS_PROFILE;
    const auth = yield* Auth.Default;
    const profile = yield* auth.loadProfile(profileName);
    if (!profile.sso_account_id) {
      return yield* Effect.die(
        `AWS SSO profile '${profileName}' is missing sso_account_id`,
      );
    }
    const region =
      profile.region ??
      (yield* AWS_REGION.pipe(
        Config.option,
        Config.map(Option.getOrElse(() => "us-east-1")),
      ));
    return {
      profile: profileName,
      accountId: profile.sso_account_id,
      region,
      credentials: auth.loadProfileCredentials(profileName),
    } satisfies AWSEnvironmentShape;
  });

export interface AWSEnvironmentStaticInput {
  accountId: AccountID;
  region: RegionID;
  credentials: AwsCredentialIdentity;
  endpoint?: string;
  profile?: string;
}

const isStatic = (
  shape: AWSEnvironmentShape | AWSEnvironmentStaticInput,
): shape is AWSEnvironmentStaticInput =>
  shape.credentials != null &&
  typeof (shape.credentials as AwsCredentialIdentity).accessKeyId === "string";

/**
 * Build an `AWSEnvironment` Layer directly from values — useful for
 * static credentials in CI or tests.
 *
 * Named `makeEnvironment` rather than `of` because `Context.Service.of`
 * already exists with different semantics (builds the service value, not
 * a Layer); putting both on `AWSEnvironment` would be confusing.
 */
export const makeEnvironment = (
  shape: AWSEnvironmentShape | AWSEnvironmentStaticInput,
) =>
  Layer.succeed(
    AWSEnvironment,
    isStatic(shape)
      ? {
          ...shape,
          credentials: Effect.succeed(
            fromAwsCredentialIdentity(shape.credentials),
          ),
        }
      : shape,
  );
