import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:dlp", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-content-policy": GCP.DLP.ContentPolicy.lookup({ contentPolicyId: name }).name,
        "missing-deidentify-template": GCP.DLP.DeidentifyTemplate.lookup({ templateId: name }).name,
        "missing-discovery-config": GCP.DLP.DiscoveryConfig.lookup({ configId: name }).name,
        "missing-inspect-template": GCP.DLP.InspectTemplate.lookup({ templateId: name }).name,
        "missing-job-trigger": GCP.DLP.JobTrigger.lookup({ triggerId: name }).name,
        "missing-locations-deidentify-template": GCP.DLP.LocationsDeidentifyTemplate.lookup({
          templateId: name,
        }).name,
        "missing-locations-dlp-job": GCP.DLP.LocationsDlpJob.lookup({ jobId: name }).name,
        "missing-locations-inspect-template": GCP.DLP.LocationsInspectTemplate.lookup({
          templateId: name,
        }).name,
        "missing-locations-job-trigger": GCP.DLP.LocationsJobTrigger.lookup({ triggerId: name })
          .name,
        "missing-locations-stored-info-type": GCP.DLP.LocationsStoredInfoType.lookup({
          storedInfoTypeId: name,
        }).name,
        "missing-stored-info-type": GCP.DLP.StoredInfoType.lookup({ storedInfoTypeId: name }).name,
      });
    }),
  { tags, timeout: 225000 },
);
