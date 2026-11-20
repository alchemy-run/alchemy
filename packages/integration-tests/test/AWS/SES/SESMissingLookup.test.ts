import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:ses", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (custom verification email template, multi region endpoint, receipt filter).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-custom-verification-email-template":
          AWS.SES.CustomVerificationEmailTemplate.lookup({ templateName: name }).templateName,
        "missing-multi-region-endpoint": AWS.SES.MultiRegionEndpoint.lookup({ endpointName: name })
          .endpointName,
        "missing-receipt-filter": AWS.SES.ReceiptFilter.lookup({ filterName: name }).filterName,
      });
    }),
  { tags, timeout: 180_000 },
);
