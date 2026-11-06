import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:dataplex", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-aspect-type": GCP.Dataplex.AspectType.lookup({ aspectTypeId: name }).name,
        "missing-data-product": GCP.Dataplex.DataProduct.lookup({ dataProductId: name }).name,
        "missing-data-products-data-asset": GCP.Dataplex.DataProductsDataAsset.lookup({
          dataAssetId: name,
          parent: name,
        }).name,
        "missing-data-scan": GCP.Dataplex.DataScan.lookup({ dataScanId: name }).name,
        "missing-entry-group": GCP.Dataplex.EntryGroup.lookup({ entryGroupId: name }).name,
        "missing-entry-groups-entry": GCP.Dataplex.EntryGroupsEntry.lookup({
          entryId: name,
          entryGroup: name,
        }).name,
        "missing-entry-type": GCP.Dataplex.EntryType.lookup({ entryTypeId: name }).name,
        "missing-glossaries-category": GCP.Dataplex.GlossariesCategory.lookup({
          categoryId: name,
          glossary: name,
        }).name,
        "missing-glossaries-term": GCP.Dataplex.GlossariesTerm.lookup({
          termId: name,
          glossary: name,
        }).name,
        "missing-glossary": GCP.Dataplex.Glossary.lookup({ glossaryId: name }).name,
        "missing-lake": GCP.Dataplex.Lake.lookup({ lakeId: name }).name,
        "missing-lakes-asset": GCP.Dataplex.LakesAsset.lookup({ assetId: name, zone: name }).name,
        "missing-lakes-entity": GCP.Dataplex.LakesEntity.lookup({ entityId: name, zone: name })
          .name,
        "missing-lakes-task": GCP.Dataplex.LakesTask.lookup({ taskId: name, lake: name }).name,
        "missing-lakes-zone": GCP.Dataplex.LakesZone.lookup({ zoneId: name, lake: name }).name,
        "missing-metadata-feed": GCP.Dataplex.MetadataFeed.lookup({ metadataFeedId: name }).name,
      });
    }),
  { tags, timeout: 300000 },
);
