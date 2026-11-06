import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:qbusiness", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (application, data source, index, retriever, web experience).
// The testing account can't use QBusiness; an entitled account sets the gate.
test.provider.skipIf(!process.env.AWS_TEST_QBUSINESS)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-application": AWS.QBusiness.Application.lookup({ displayName: name })
          .applicationId,
        "missing-data-source": AWS.QBusiness.DataSource.lookup({
          applicationId: "11111111-1111-4111-8111-111111111111",
          indexId: "11111111-1111-4111-8111-111111111111",
          displayName: name,
        }).dataSourceId,
        "missing-retriever": AWS.QBusiness.Retriever.lookup({
          applicationId: "11111111-1111-4111-8111-111111111111",
          displayName: name,
        }).retrieverId,
        "missing-index": AWS.QBusiness.Index.lookup({
          applicationId: "11111111-1111-4111-8111-111111111111",
          displayName: name,
        }).indexId,
        "missing-web-experience": AWS.QBusiness.WebExperience.lookup({
          applicationId: "11111111-1111-4111-8111-111111111111",
          webExperienceId: "11111111-1111-4111-8111-111111111111",
        }).webExperienceId,
      });
    }),
  { tags, timeout: 180_000 },
);
