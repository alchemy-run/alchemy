import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:cognito", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (group, identity provider, resource server, user pool domain).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        "missing-group": AWS.Cognito.Group.lookup({
          userPoolId: `${region}_AAAAAAAAA`,
          groupName: name,
        }).groupName,
        "missing-identity-provider": AWS.Cognito.IdentityProvider.lookup({
          userPoolId: `${region}_AAAAAAAAA`,
          providerName: "MissingIdp",
        }).providerName,
        "missing-resource-server": AWS.Cognito.ResourceServer.lookup({
          userPoolId: `${region}_AAAAAAAAA`,
          identifier: name,
        }).identifier,
        "missing-user-pool-domain": AWS.Cognito.UserPoolDomain.lookup({ domain: name }).domain,
      });
    }),
  { tags, timeout: 180_000 },
);
