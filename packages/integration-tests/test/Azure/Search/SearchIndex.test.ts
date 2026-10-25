import * as Azure from "@alchemy.run/azure";
import * as searchData from "@distilled.cloud/azure/search-data";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getIndex = (endpoint: string, indexName: string) =>
  searchData.GetIndex({ endpoint, indexName });

/** `"gone"` once the index answers a typed not-found. */
const indexGone = (endpoint: string, indexName: string) =>
  getIndex(endpoint, indexName).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

const baseFields: Azure.Search.SearchIndexField[] = [
  { name: "id", type: "Edm.String", key: true },
  { name: "title", type: "Edm.String", searchable: true },
];

const program = (props: Omit<Azure.Search.SearchIndexProps, "resourceGroup" | "searchService">) =>
  Effect.gen(function* () {
    const service = yield* Azure.Search.SearchService("IndexService", {
      sku: "basic",
      authMode: "aadOrApiKey",
    });
    const index = yield* Azure.Search.SearchIndex("Index", {
      searchService: service.searchServiceName,
      ...props,
    });
    return { service, index };
  });

// Basic tier (~$0.11/hour, billed per started hour): ~$0.11 per run, ~4-8 minutes.
test.provider(
  "create, update, replace, and delete a search index",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { service, index } = yield* stack.deploy(
        program({
          fields: baseFields,
          suggesters: [
            { name: "titles", searchMode: "analyzingInfixMatching", sourceFields: ["title"] },
          ],
        }),
      );
      expect(index.endpoint).toEqual(service.endpoint.replace(/\/+$/, ""));
      expect(index.indexId).toEqual(`${service.searchServiceId}/indexes/${index.indexName}`);
      expect(index.keyField).toEqual("id");
      expect(index.fieldNames).toEqual(["id", "title"]);
      const observed = yield* getIndex(index.endpoint, index.indexName);
      expect(observed.fields.map((f) => [f.name, f.type, f.key ?? false])).toEqual([
        ["id", "Edm.String", true],
        ["title", "Edm.String", false],
      ]);
      expect(observed.suggesters?.map((s) => s.sourceFields)).toEqual([["title"]]);

      // In place: a new field, a description, and CORS.
      const updated = yield* stack.deploy(
        program({
          description: "lifecycle test",
          fields: [...baseFields, { name: "year", type: "Edm.Int32", filterable: true }],
          suggesters: [
            { name: "titles", searchMode: "analyzingInfixMatching", sourceFields: ["title"] },
          ],
          corsOptions: { allowedOrigins: ["https://example.com"], maxAgeInSeconds: 60 },
        }),
      );
      expect(updated.index.indexName).toEqual(index.indexName);
      expect(updated.index.fieldNames).toEqual(["id", "title", "year"]);
      const reobserved = yield* getIndex(index.endpoint, index.indexName);
      expect(reobserved.description).toEqual("lifecycle test");
      expect(reobserved.fields.find((f) => f.name === "year")?.filterable).toEqual(true);
      expect(reobserved.corsOptions?.allowedOrigins).toEqual(["https://example.com"]);

      // Replacement: an existing field cannot change type.
      const replaced = yield* stack.deploy(
        program({
          fields: [...baseFields, { name: "year", type: "Edm.String", filterable: true }],
        }),
      );
      expect(replaced.index.indexName).not.toEqual(index.indexName);
      const replacedObserved = yield* getIndex(replaced.index.endpoint, replaced.index.indexName);
      expect(replacedObserved.fields.find((f) => f.name === "year")?.type).toEqual("Edm.String");
      expect(replacedObserved.suggesters ?? []).toEqual([]);
      expect(yield* indexGone(index.endpoint, index.indexName)).toEqual("gone");

      // Delete the index alone, then the service.
      const serviceOnly = yield* stack.deploy(
        Effect.gen(function* () {
          const kept = yield* Azure.Search.SearchService("IndexService", {
            sku: "basic",
            authMode: "aadOrApiKey",
          });
          return { service: kept };
        }),
      );
      expect(serviceOnly.service.searchServiceName).toEqual(service.searchServiceName);
      expect(yield* indexGone(replaced.index.endpoint, replaced.index.indexName)).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
