import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:analyticshub", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-data-exchange": GCP.AnalyticsHub.DataExchange.lookup({ dataExchangeId: name })
          .name,
        "missing-data-exchanges-listing": GCP.AnalyticsHub.DataExchangesListing.lookup({
          listingId: name,
          dataExchange: name,
        }).name,
        "missing-data-exchanges-query-template": GCP.AnalyticsHub.DataExchangesQueryTemplate.lookup(
          { queryTemplateId: name, dataExchange: name },
        ).name,
      });
    }),
  { tags, timeout: 105000 },
);
