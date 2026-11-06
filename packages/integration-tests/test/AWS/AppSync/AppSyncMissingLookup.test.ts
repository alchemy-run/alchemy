import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:appsync", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (data source resource, domain name, function resource).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-data-source-resource": AWS.AppSync.DataSourceResource.lookup({
          apiId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
          name: "missing_lookup",
        }).apiId,
        "missing-domain-name": AWS.AppSync.DomainName.lookup({ domainName: name }).domainName,
        "missing-function-resource": AWS.AppSync.FunctionResource.lookup({
          apiId: name,
          name: name,
        }).apiId,
      });
    }),
  { tags, timeout: 180_000 },
);
