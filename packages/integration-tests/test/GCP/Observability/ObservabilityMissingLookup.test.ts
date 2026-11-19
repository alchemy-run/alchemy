import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:observability", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-buckets-datasets-link": GCP.Observability.BucketsDatasetsLink.lookup({
          linkId: name,
          dataset: name,
        }).name,
        "missing-trace-scope": GCP.Observability.TraceScope.lookup({ traceScopeId: name }).name,
      });
    }),
  { tags, timeout: 90000 },
);
