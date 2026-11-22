import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:apigateway", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (API key, VPC link, authorizer, deployment resource, domain name, stage resource, usage plan).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-api-key": AWS.ApiGateway.ApiKey.lookup({ apiKeyId: name }).id,
        "missing-authorizer": AWS.ApiGateway.Authorizer.lookup({
          authorizerId: name,
          restApiId: name,
        }).authorizerId,
        "missing-deployment-resource": AWS.ApiGateway.DeploymentResource.lookup({
          deploymentId: name,
          restApiId: name,
        }).deploymentId,
        "missing-domain-name": AWS.ApiGateway.DomainName.lookup({
          domainName: `${name}.example.com`,
        }).domainName,
        "missing-stage-resource": AWS.ApiGateway.StageResource.lookup({
          restApiId: name,
          stageName: name,
        }).restApiId,
        "missing-usage-plan": AWS.ApiGateway.UsagePlan.lookup({ usagePlanId: name }).id,
        "missing-vpc-link": AWS.ApiGateway.VpcLink.lookup({ vpcLinkId: name }).vpcLinkId,
      });
    }),
  { tags, timeout: 180_000 },
);
