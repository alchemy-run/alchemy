import * as GCP from "@alchemy.run/gcp";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

/** DiscoveryEngine resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeCollectionsDataStore = GCP.DiscoveryEngine.CollectionsDataStore(
  "ProbeCollectionsDataStore",
  {
    location: "global",
    displayName: "docs",
    industryVertical: "GENERIC",
    contentConfig: "NO_CONTENT",
    solutionTypes: ["SOLUTION_TYPE_SEARCH"],
    disableCmek: true,
  },
);
export const ProbeDataStore = GCP.DiscoveryEngine.DataStore("ProbeDataStore", {
  location: "global",
  displayName: "docs",
  industryVertical: "GENERIC",
  contentConfig: "NO_CONTENT",
  solutionTypes: ["SOLUTION_TYPE_SEARCH"],
  disableCmek: true,
});

const SCHEMA = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { title: { type: "string" } },
});

/** A data store with no default schema, for the schema bindings. */
export const ProbeSchemaStore = GCP.DiscoveryEngine.CollectionsDataStore("ProbeSchemaStore", {
  location: "global",
  displayName: "probe-schema",
  skipDefaultSchemaCreation: true,
  disableCmek: true,
});
export const ProbeSchema = Effect.gen(function* () {
  const store = yield* ProbeSchemaStore;
  return yield* GCP.DiscoveryEngine.CollectionsDataStoresSchema("ProbeSchema", {
    dataStore: store.name,
    schemaId: "fields",
    jsonSchema: SCHEMA,
  });
});
export const ProbeDocument = Effect.gen(function* () {
  const store = yield* ProbeCollectionsDataStore;
  return yield* GCP.DiscoveryEngine.CollectionsDataStoresBranchesDocument("ProbeDocument", {
    dataStore: store.name,
    jsonData: JSON.stringify({ title: "About us", uri: "https://example.com/about" }),
  });
});
export const ProbeSession = Effect.gen(function* () {
  const store = yield* ProbeCollectionsDataStore;
  const engine = yield* ProbeEngine;
  return yield* GCP.DiscoveryEngine.CollectionsDataStoresSession("ProbeSession", {
    // through the engine: controls and sessions need the store attached to one
    dataStore: Output.all(store.name, engine.name).pipe(Output.map(([name]) => name)),
    displayName: "chat",
  });
});
export const ProbeSiteStore = GCP.DiscoveryEngine.CollectionsDataStore("ProbeSiteStore", {
  location: "global",
  displayName: "probe-site",
  contentConfig: "PUBLIC_WEBSITE",
  disableCmek: true,
});
export const ProbeTargetSite = Effect.gen(function* () {
  const store = yield* ProbeSiteStore;
  return yield* GCP.DiscoveryEngine.CollectionsDataStoresSiteSearchEngineTargetSite(
    "ProbeTargetSite",
    { dataStore: store.name, providedUriPattern: "www.example.com/docs/", type: "INCLUDE" },
  );
});
export const ProbeEngine = Effect.gen(function* () {
  const store = yield* ProbeCollectionsDataStore;
  return yield* GCP.DiscoveryEngine.CollectionsEngine("ProbeEngine", {
    location: "global",
    dataStoreIds: [store.dataStoreId],
    displayName: "probe engine",
    solutionType: "SOLUTION_TYPE_SEARCH",
    industryVertical: "GENERIC",
  });
});
export const ProbeStoreControl = Effect.gen(function* () {
  const store = yield* ProbeCollectionsDataStore;
  const engine = yield* ProbeEngine;
  return yield* GCP.DiscoveryEngine.CollectionsDataStoresControl("ProbeStoreControl", {
    // through the engine, so it is created once the store has one
    dataStore: Output.all(store.name, engine.name).pipe(Output.map(([name]) => name)),
    displayName: "greetings",
    synonyms: ["hello", "hi"],
  });
});
export const ProbeStoreServing = Effect.gen(function* () {
  const store = yield* ProbeCollectionsDataStore;
  const engine = yield* ProbeEngine;
  return yield* GCP.DiscoveryEngine.CollectionsDataStoresServingConfig("ProbeStoreServing", {
    // through the engine, so it is created once the store has one
    dataStore: Output.all(store.name, engine.name).pipe(Output.map(([name]) => name)),
    displayName: "preview",
  });
});
export const ProbeEngineControl = Effect.gen(function* () {
  const engine = yield* ProbeEngine;
  return yield* GCP.DiscoveryEngine.CollectionsEnginesControl("ProbeEngineControl", {
    engine: engine.name,
    displayName: "hello-hi",
    synonymsAction: { synonyms: ["hello", "hi"] },
  });
});
export const ProbeEngineServing = Effect.gen(function* () {
  const engine = yield* ProbeEngine;
  return yield* GCP.DiscoveryEngine.CollectionsEnginesServingConfig("ProbeEngineServing", {
    engine: engine.name,
    displayName: "primary",
    solutionType: "SOLUTION_TYPE_SEARCH",
  });
});
export const ProbeEngineSession = Effect.gen(function* () {
  const engine = yield* ProbeEngine;
  return yield* GCP.DiscoveryEngine.CollectionsEnginesSession("ProbeEngineSession", {
    engine: engine.name,
    displayName: "support",
  });
});

/** The same children under a location-scoped data store. */
export const ProbeLocSchemaStore = GCP.DiscoveryEngine.DataStore("ProbeLocSchemaStore", {
  location: "global",
  displayName: "probe-loc-schema",
  industryVertical: "GENERIC",
  solutionTypes: ["SOLUTION_TYPE_SEARCH"],
  skipDefaultSchemaCreation: true,
  disableCmek: true,
});
export const ProbeLocSchema = Effect.gen(function* () {
  const store = yield* ProbeLocSchemaStore;
  return yield* GCP.DiscoveryEngine.DataStoresSchema("ProbeLocSchema", {
    dataStore: store.name,
    schemaId: "fields",
    jsonSchema: SCHEMA,
  });
});
export const ProbeLocDocument = Effect.gen(function* () {
  const store = yield* ProbeDataStore;
  return yield* GCP.DiscoveryEngine.DataStoresBranchesDocument("ProbeLocDocument", {
    dataStore: store.name,
    jsonData: JSON.stringify({ title: "About us", uri: "https://example.com/about" }),
  });
});
export const ProbeLocSession = Effect.gen(function* () {
  const store = yield* ProbeDataStore;
  const engine = yield* ProbeLocEngine;
  return yield* GCP.DiscoveryEngine.DataStoresSession("ProbeLocSession", {
    // through the engine: controls and sessions need the store attached to one
    dataStore: Output.all(store.name, engine.name).pipe(Output.map(([name]) => name)),
    displayName: "chat",
  });
});
export const ProbeLocSiteStore = GCP.DiscoveryEngine.DataStore("ProbeLocSiteStore", {
  location: "global",
  displayName: "probe-loc-site",
  industryVertical: "GENERIC",
  solutionTypes: ["SOLUTION_TYPE_SEARCH"],
  contentConfig: "PUBLIC_WEBSITE",
  disableCmek: true,
});
export const ProbeLocTargetSite = Effect.gen(function* () {
  const store = yield* ProbeLocSiteStore;
  return yield* GCP.DiscoveryEngine.DataStoresSiteSearchEngineTargetSite("ProbeLocTargetSite", {
    dataStore: store.name,
    providedUriPattern: "www.example.com/docs/",
    type: "INCLUDE",
  });
});
export const ProbeLocControl = Effect.gen(function* () {
  const store = yield* ProbeDataStore;
  const engine = yield* ProbeLocEngine;
  return yield* GCP.DiscoveryEngine.DataStoresControl("ProbeLocControl", {
    // through the engine: controls and sessions need the store attached to one
    dataStore: Output.all(store.name, engine.name).pipe(Output.map(([name]) => name)),
    displayName: "greetings",
    solutionType: "SOLUTION_TYPE_SEARCH",
    synonymsAction: { synonyms: ["hello", "hi"] },
  });
});
/** A serving config needs an engine over its data store. */
const ProbeLocEngine = Effect.gen(function* () {
  const store = yield* ProbeDataStore;
  return yield* GCP.DiscoveryEngine.CollectionsEngine("ProbeLocEngine", {
    location: "global",
    dataStoreIds: [store.dataStoreId],
    displayName: "probe docs engine",
    solutionType: "SOLUTION_TYPE_SEARCH",
    industryVertical: "GENERIC",
  });
});
export const ProbeLocServing = Effect.gen(function* () {
  const store = yield* ProbeDataStore;
  const engine = yield* ProbeLocEngine;
  return yield* GCP.DiscoveryEngine.DataStoresServingConfig("ProbeLocServing", {
    // through the engine, so the config is created once the store has one
    dataStore: Output.all(store.name, engine.name).pipe(Output.map(([name]) => name)),
    displayName: "preview",
    solutionType: "SOLUTION_TYPE_SEARCH",
  });
});
