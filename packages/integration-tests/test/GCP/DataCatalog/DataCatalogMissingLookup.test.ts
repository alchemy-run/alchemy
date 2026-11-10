import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:datacatalog", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { project } = yield* GcpEnvironment.current;
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-taxonomies-policy-tag": GCP.DataCatalog.TaxonomiesPolicyTag.lookup({
          name: `projects/${project}/locations/us-central1/taxonomies/1/policyTags/1`,
        }).name,
        "missing-taxonomy": GCP.DataCatalog.Taxonomy.lookup({
          name: `projects/${project}/locations/us-central1/taxonomies/1`,
        }).name,
      });
    }),
  { tags, timeout: 90000 },
);
