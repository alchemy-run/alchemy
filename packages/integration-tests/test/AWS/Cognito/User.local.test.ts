/**
 * `AWS.Cognito.User` under `alchemy dev`: the dualized providers deploy a
 * user pool, an app client and a confirmed user into the floci emulator,
 * and the user can sign in and read their sign-in factors there
 * (`GetUserAuthFactors`, issue #2350).
 */
import * as AWS from "@alchemy.run/aws";
import { User, UserPool, UserPoolClient } from "@alchemy.run/aws/Cognito";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { rawAwsJson, regionOfArn } from "../Local/fixtures/raw.ts";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

const PASSWORD = "Alchemy-User-Passw0rd1";

const cognito = (region: string, operation: string, body: Record<string, unknown>) =>
  rawAwsJson({
    service: "cognito-idp",
    region,
    target: `AWSCognitoIdentityProviderService.${operation}`,
    contentType: "application/x-amz-json-1.1",
    body,
  });

test.provider(
  "dev user signs in and reads its auth factors against floci",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { pool, client, user } = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* UserPool("LocalAuthFactorsPool", {});
          const client = yield* UserPoolClient("LocalAuthFactorsClient", {
            userPoolId: pool.userPoolId,
            explicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
          });
          const user = yield* User("LocalAuthFactorsUser", {
            userPoolId: pool.userPoolId,
            attributes: {
              email: "factors@example.com",
              email_verified: "true",
            },
            password: Redacted.make(PASSWORD),
          });
          return { pool, client, user };
        }),
      );

      expect(pool.userPoolArn).toContain(":000000000000:");
      const region = regionOfArn(pool.userPoolArn);

      const auth = yield* cognito(region, "InitiateAuth", {
        ClientId: client.clientId,
        AuthFlow: "USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: user.username, PASSWORD },
      });
      expect(auth.status).toBe(200);
      const { AuthenticationResult } = (yield* auth.json) as {
        AuthenticationResult: { AccessToken: string };
      };

      const factors = yield* cognito(region, "GetUserAuthFactors", {
        AccessToken: AuthenticationResult.AccessToken,
      });
      const body = (yield* factors.json) as {
        Username?: string;
        ConfiguredUserAuthFactors?: string[];
      };
      expect({ status: factors.status, body }).toEqual({
        status: 200,
        body: {
          Username: user.username,
          ConfiguredUserAuthFactors: ["PASSWORD", "EMAIL_OTP"],
        },
      });

      const invalid = yield* cognito(region, "GetUserAuthFactors", {
        AccessToken: "not-a-token",
      });
      expect(invalid.status).toBe(400);
      expect(((yield* invalid.json) as { __type: string }).__type).toBe("NotAuthorizedException");

      yield* stack.destroy();

      const after = yield* cognito(region, "DescribeUserPool", {
        UserPoolId: pool.userPoolId,
      });
      expect(after.status).toBe(400);
    }),
  {
    tags: ["provider:aws", "provider:aws:cognito", "local"],
    timeout: 180_000,
  },
);
