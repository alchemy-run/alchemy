import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:discoveryengine", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-collections-data-store": GCP.DiscoveryEngine.CollectionsDataStore.lookup({
          dataStoreId: name,
        }).name,
        "missing-collections-data-stores-control":
          GCP.DiscoveryEngine.CollectionsDataStoresControl.lookup({
            controlId: name,
            dataStore: name,
          }).name,
        "missing-collections-data-stores-serving-config":
          GCP.DiscoveryEngine.CollectionsDataStoresServingConfig.lookup({
            servingConfigId: name,
            dataStore: name,
          }).name,
        "missing-collections-data-stores-session":
          GCP.DiscoveryEngine.CollectionsDataStoresSession.lookup({
            sessionId: name,
            dataStore: name,
          }).name,
        "missing-collections-engine": GCP.DiscoveryEngine.CollectionsEngine.lookup({
          engineId: name,
        }).name,
        "missing-collections-engines-assistant":
          GCP.DiscoveryEngine.CollectionsEnginesAssistant.lookup({
            assistantId: name,
            engine: name,
          }).name,
        "missing-collections-engines-control": GCP.DiscoveryEngine.CollectionsEnginesControl.lookup(
          { controlId: name, engine: name },
        ).name,
        "missing-collections-engines-serving-config":
          GCP.DiscoveryEngine.CollectionsEnginesServingConfig.lookup({
            servingConfigId: name,
            engine: name,
          }).name,
        "missing-collections-engines-session": GCP.DiscoveryEngine.CollectionsEnginesSession.lookup(
          { sessionId: name, engine: name },
        ).name,
        "missing-data-store": GCP.DiscoveryEngine.DataStore.lookup({ dataStoreId: name }).name,
        "missing-data-stores-control": GCP.DiscoveryEngine.DataStoresControl.lookup({
          controlId: name,
          dataStore: name,
        }).name,
        "missing-data-stores-schema": GCP.DiscoveryEngine.DataStoresSchema.lookup({
          schemaId: name,
          dataStore: name,
        }).name,
        "missing-data-stores-serving-config": GCP.DiscoveryEngine.DataStoresServingConfig.lookup({
          servingConfigId: name,
          dataStore: name,
        }).name,
        "missing-data-stores-session": GCP.DiscoveryEngine.DataStoresSession.lookup({
          sessionId: name,
          dataStore: name,
        }).name,
        "missing-data-stores-site-search-engine-target-site":
          GCP.DiscoveryEngine.DataStoresSiteSearchEngineTargetSite.lookup({
            providedUriPattern: name,
            dataStore: name,
          }).name,
        "missing-identity-mapping-store": GCP.DiscoveryEngine.IdentityMappingStore.lookup({
          identityMappingStoreId: name,
        }).name,
      });
    }),
  { tags, timeout: 300000 },
);
