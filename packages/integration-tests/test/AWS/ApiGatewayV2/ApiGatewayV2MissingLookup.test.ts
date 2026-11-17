import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:apigatewayv2", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (VPC link, authorizer resource, domain name, integration resource, stage resource).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-authorizer-resource": AWS.ApiGatewayV2.AuthorizerResource.lookup({
          apiId: name,
          authorizerId: name,
        }).apiId,
        "missing-domain-name": AWS.ApiGatewayV2.DomainName.lookup({
          domainName: `${name}.example.com`,
        }).domainName,
        "missing-integration-resource": AWS.ApiGatewayV2.IntegrationResource.lookup({
          apiId: name,
          integrationId: name,
        }).apiId,
        "missing-stage-resource": AWS.ApiGatewayV2.StageResource.lookup({
          apiId: name,
          stageName: name,
        }).apiId,
        "missing-vpc-link": AWS.ApiGatewayV2.VpcLink.lookup({ vpcLinkId: name }).vpcLinkId,
      });
    }),
  { tags, timeout: 180_000 },
);
