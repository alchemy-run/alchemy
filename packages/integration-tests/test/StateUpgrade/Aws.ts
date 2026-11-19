import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as kms from "@distilled.cloud/aws/kms";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * The environment a CI job deploys with: alchemy reads AWS credentials from
 * `AWS_*` variables in CI instead of a profile. These are the test's own.
 */
export const awsCiEnv = Effect.gen(function* () {
  const credentials = yield* yield* Credentials;
  const { region } = yield* AWSEnvironment.current;
  return {
    AWS_ACCESS_KEY_ID: Redacted.value(credentials.accessKeyId),
    AWS_SECRET_ACCESS_KEY: Redacted.value(credentials.secretAccessKey),
    ...(credentials.sessionToken === undefined
      ? {}
      : { AWS_SESSION_TOKEN: Redacted.value(credentials.sessionToken) }),
    AWS_REGION: region,
  };
});

/**
 * Remove the test store's own KMS key, which teardown keeps, so the next run
 * starts on an account the new version has never run on.
 */
export const forgetStateKey = (alias: string) =>
  kms.describeKey({ KeyId: alias }).pipe(
    Effect.map((result) => result.KeyMetadata),
    Effect.catchTag("NotFoundException", () => Effect.undefined),
    Effect.flatMap((metadata) =>
      metadata === undefined
        ? Effect.void
        : Effect.all([
            kms
              .deleteAlias({ AliasName: alias })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
            metadata.KeyState === "PendingDeletion"
              ? Effect.void
              : kms.scheduleKeyDeletion({ KeyId: metadata.KeyId, PendingWindowInDays: 7 }),
          ]),
    ),
  );
