import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

/** Accepts Microsoft Entra ID tokens on the data plane. */
export const Service = Azure.Search.SearchService("SrchBindService", {
  sku: "basic",
  authMode: "aadOrApiKey",
});

const fields: Azure.Search.SearchIndexField[] = [
  { name: "id", type: "Edm.String", key: true },
  { name: "name", type: "Edm.String", searchable: true },
  { name: "city", type: "Edm.String", filterable: true, facetable: true },
  { name: "rating", type: "Edm.Int32", filterable: true, sortable: true },
];

const index = (id: string) =>
  Effect.gen(function* () {
    const service = yield* Service;
    return yield* Azure.Search.SearchIndex(id, {
      searchService: service.searchServiceName,
      fields,
      suggesters: [{ name: "names", searchMode: "analyzingInfixMatching", sourceFields: ["name"] }],
    });
  });

/** Seeded by the deployer; queried by the read bindings. */
export const Catalog = index("SrchCatalog");
/** Written by the write bindings. */
export const Inbox = index("SrchInbox");

/** The documents the test seeds into {@link Catalog}. */
export const CATALOG_DOCUMENTS = [
  { id: "1", name: "Seaside Inn", city: "Brighton", rating: 4 },
  { id: "2", name: "Seaview Lodge", city: "Dover", rating: 3 },
  { id: "3", name: "Mountain Hut", city: "Zermatt", rating: 5 },
];

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/** The `_tag` an effect fails with (`"none"` when it succeeds). */
const failureTag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as("none"),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

/** Fail (so the caller retries) until `ready` holds, e.g. a write became visible. */
const until = <A, E, R>(effect: Effect.Effect<A, E, R>, ready: (a: A) => boolean) =>
  Effect.flatMap(effect, (a) =>
    ready(a) ? Effect.succeed(a) : Effect.fail(new Error("not visible yet")),
  );

const sorted = (values: unknown[]) => values.map(String).sort();

/**
 * Effect-native Azure Function exercising every Azure AI Search index
 * binding on a managed-identity host, one route per binding. Routes answer
 * `{ ok, result | error }` with a 500 on error, so a caller retries through
 * the cold start and role propagation, and a real failure shows the Azure
 * error.
 */
export default class SearchFunction extends Azure.Functions.Function<SearchFunction>()(
  "SearchFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const catalog = yield* Catalog;
    const inbox = yield* Inbox;

    const searchDocuments = yield* Azure.Search.SearchDocuments(catalog);
    const getDocument = yield* Azure.Search.GetDocument(catalog);
    const countDocuments = yield* Azure.Search.CountDocuments(catalog);
    const suggestDocuments = yield* Azure.Search.SuggestDocuments(catalog);
    const autocompleteDocuments = yield* Azure.Search.AutocompleteDocuments(catalog);
    const getIndexStatistics = yield* Azure.Search.GetIndexStatistics(catalog);
    const read = yield* Azure.Search.SearchIndexRead(catalog);

    const indexDocuments = yield* Azure.Search.IndexDocuments(inbox);
    const write = yield* Azure.Search.SearchIndexWrite(inbox);
    const readWrite = yield* Azure.Search.SearchIndexReadWrite(inbox);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const key = url.searchParams.get("key") ?? "";
        switch (url.pathname) {
          case "/search":
            return yield* respond(
              Effect.map(
                searchDocuments({ search: "seaside", count: true, select: "id,name" }),
                (result) => ({
                  count: result._odata_count,
                  hits: result.value.map((hit) => ({ id: hit.id, name: hit.name })),
                }),
              ),
            );
          case "/get":
            return yield* respond(
              Effect.gen(function* () {
                const document = yield* getDocument({ key: "2", _select: "id,name" });
                const missing = yield* failureTag(getDocument({ key: "missing" }));
                return { document: { id: document.id, name: document.name }, missing };
              }),
            );
          case "/count":
            return yield* respond(Effect.map(countDocuments(), (count) => ({ count })));
          case "/suggest":
            return yield* respond(
              Effect.map(
                suggestDocuments({ search: "sea", suggesterName: "names", select: "id,name" }),
                (result) => ({ ids: sorted(result.value.map((s) => s.id)) }),
              ),
            );
          case "/autocomplete":
            return yield* respond(
              Effect.map(
                autocompleteDocuments({ search: "sea", suggesterName: "names" }),
                (result) => ({ terms: sorted(result.value.map((item) => item.text)) }),
              ),
            );
          case "/stats":
            return yield* respond(
              Effect.map(
                // Statistics trail writes by a few seconds.
                until(getIndexStatistics(), (stats) => stats.documentCount === 3),
                (stats) => ({ documentCount: stats.documentCount, storageSize: stats.storageSize }),
              ),
            );
          case "/read":
            return yield* respond(
              Effect.gen(function* () {
                const hits = yield* read.search({ filter: "rating ge 4", orderby: "rating desc" });
                const document = yield* read.get("3", ["id", "city"]);
                const missing = yield* read.get("missing");
                const count = yield* read.count();
                const suggestions = yield* read.suggest({ search: "sea", suggesterName: "names" });
                const terms = yield* read.autocomplete({ search: "mou", suggesterName: "names" });
                return {
                  ids: hits.value.map((hit) => hit.id),
                  document,
                  missing: missing === undefined,
                  count,
                  suggestions: sorted(suggestions.value.map((s) => s.id)),
                  terms: terms.value.map((item) => item.text),
                };
              }),
            );

          case "/index":
            return yield* respond(
              Effect.map(
                indexDocuments({
                  value: [
                    { _search_action: "upload", id: key, name: "Uploaded by IndexDocuments" },
                    { _search_action: "delete", id: `${key}-absent` },
                  ],
                }),
                (result) =>
                  result.value.map((r) => ({ key: r.key, status: r.status, code: r.statusCode })),
              ),
            );
          case "/write":
            return yield* respond(
              Effect.gen(function* () {
                const uploaded = yield* write.upload([{ id: key, name: "Written", rating: 1 }]);
                const merged = yield* write.merge([{ id: key, rating: 2 }]);
                const extra = yield* write.mergeOrUpload([{ id: `${key}-extra`, name: "Extra" }]);
                const deleted = yield* write.delete([{ id: `${key}-extra` }]);
                return [...uploaded, ...merged, ...extra, ...deleted].map((r) => ({
                  key: r.key,
                  status: r.status,
                }));
              }),
            );
          case "/read-write":
            return yield* respond(
              Effect.gen(function* () {
                yield* readWrite.mergeOrUpload([{ id: key, name: "Read and written" }]);
                const document = yield* until(readWrite.get(key), (d) => d !== undefined);
                return { name: document?.name };
              }),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Search.SearchDocumentsHttp,
        Azure.Search.GetDocumentHttp,
        Azure.Search.CountDocumentsHttp,
        Azure.Search.SuggestDocumentsHttp,
        Azure.Search.AutocompleteDocumentsHttp,
        Azure.Search.GetIndexStatisticsHttp,
        Azure.Search.SearchIndexReadHttp,
        Azure.Search.IndexDocumentsHttp,
        Azure.Search.SearchIndexWriteHttp,
        Azure.Search.SearchIndexReadWriteHttp,
      ),
    ),
  ),
) {}
