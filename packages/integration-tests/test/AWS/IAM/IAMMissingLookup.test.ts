import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:iam", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (SAML provider, open ID connect provider, server certificate).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        "missing-open-id-connect-provider": AWS.IAM.OpenIDConnectProvider.lookup({
          openIDConnectProviderArn: `arn:aws:iam::${accountId}:oidc-provider/${name}.example.com`,
        }).openIDConnectProviderArn,
        "missing-saml-provider": AWS.IAM.SAMLProvider.lookup({
          samlProviderArn: `arn:aws:iam::${accountId}:saml-provider/${name}`,
        }).samlProviderArn,
        "missing-server-certificate": AWS.IAM.ServerCertificate.lookup({
          serverCertificateName: name,
        }).serverCertificateArn,
      });
    }),
  { tags, timeout: 180_000 },
);
