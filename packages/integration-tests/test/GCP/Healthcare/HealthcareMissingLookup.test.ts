import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:healthcare", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-dataset": GCP.Healthcare.Dataset.lookup({ datasetId: name }).name,
        "missing-datasets-consent-store": GCP.Healthcare.DatasetsConsentStore.lookup({
          consentStoreId: name,
          dataset: name,
        }).name,
        "missing-datasets-dicom-store": GCP.Healthcare.DatasetsDicomStore.lookup({
          dicomStoreId: name,
          dataset: name,
        }).name,
        "missing-datasets-fhir-store": GCP.Healthcare.DatasetsFhirStore.lookup({
          fhirStoreId: name,
          dataset: name,
        }).name,
        "missing-datasets-hl7-v2-store": GCP.Healthcare.DatasetsHl7V2Store.lookup({
          hl7V2StoreId: name,
          dataset: name,
        }).name,
      });
    }),
  { tags, timeout: 135000 },
);
