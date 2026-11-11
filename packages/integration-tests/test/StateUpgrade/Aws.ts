import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { Credentials } from "@distilled.cloud/aws/Credentials";
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
