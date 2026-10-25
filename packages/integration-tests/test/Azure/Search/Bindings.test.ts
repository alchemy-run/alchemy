import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as searchData from "@distilled.cloud/azure/search-data";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import SearchFunction, { CATALOG_DOCUMENTS, Catalog, Inbox, Service } from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Built-in **Search Index Data Contributor**: the deployer's out-of-band data-plane access. */
const SEARCH_INDEX_DATA_CONTRIBUTOR = "8ebe5a00-799e-43f5-93ac-243d3dce84a7";

/** Object ID (`oid` claim) of the identity running the tests. */
const callerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureSearchBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* SearchFunction;
    const service = yield* Service;
    const catalog = yield* Catalog;
    const inbox = yield* Inbox;
    // Lets the deployer seed the catalog and verify each write out of band.
    const deployer = yield* callerObjectId.pipe(Effect.orDie);
    yield* Azure.Authorization.RoleAssignment("SrchDeployerDataContributor", {
      scope: service.searchServiceId,
      roleDefinitionId: SEARCH_INDEX_DATA_CONTRIBUTOR,
      principalId: deployer,
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      endpoint: service.endpoint,
      catalogName: catalog.indexName,
      catalogId: catalog.indexId,
      inboxName: inbox.indexName,
      inboxId: inbox.indexId,
    };
  }),
);

// Basic search service (~$0.11 per started hour) + Flex Consumption; ~$0.12/run, ~8 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Deployer credentials and environment for out-of-band checks and hooks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation (about 4 minutes), then return the last
 * answer so a real failure shows its Azure error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.execute(HttpClientRequest.get(`${url}${route}`)).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.flatMap((json) => (json?.ok ? Effect.succeed(json) : Effect.fail(json))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
      Effect.catch((json) => Effect.succeed(json as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** Retry a deployer data-plane call through the deployer's own role propagation. */
const asDeployer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 18 }),
    Effect.provide(azure),
  );

/** Upload the catalog documents as the deployer (idempotent). */
const seedCatalog = Effect.gen(function* () {
  const { endpoint, catalogName } = yield* stack;
  const result = yield* asDeployer(
    searchData.ListDocuments({
      endpoint,
      indexName: catalogName,
      value: CATALOG_DOCUMENTS.map((d) => ({ ...d, _search_action: "mergeOrUpload" })),
    }),
  );
  expect(result.value.map((r) => r.status)).toEqual([true, true, true]);
  // Writes reach queries within about a second; wait so assertions see them.
  const count = yield* searchData.DocumentsCount({ endpoint, indexName: catalogName }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (n) => n === CATALOG_DOCUMENTS.length,
      times: 15,
    }),
    Effect.provide(azure),
  );
  expect(count).toEqual(CATALOG_DOCUMENTS.length);
});

/** A document of the inbox index read as the deployer: its fields, or the failure tag. */
const inboxDocument = (key: string) =>
  Effect.gen(function* () {
    const { endpoint, inboxName } = yield* stack;
    return yield* searchData.GetDocument({ endpoint, indexName: inboxName, key }).pipe(
      Effect.map((document) => ({ ...document }) as Record<string, unknown>),
      Effect.catchTag("NotFound", () => Effect.succeed<Record<string, unknown>>({ missing: true })),
      Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 18 }),
      Effect.provide(azure),
    );
  });

/** Role assignments of the Function's identity, without its own host-storage grants. */
const assignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    // Every page: a filtered list can answer an empty first page with a `nextLink`.
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    return Array.from(assignments).filter(
      (a) => !/\/storageaccounts\/[^/]+$/.test(a.properties?.scope?.toLowerCase() ?? ""),
    );
  });

/** Every role on the Function's identity as `<actions> <scope>`. */
const grantsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const grants: string[] = [];
    for (const assignment of yield* assignmentsOf(principalId)) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      const actions = (definition.properties?.permissions ?? [])
        .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
        .map((a) => a.replace("Microsoft.Search/searchServices/indexes/", ""))
        .sort()
        .join("+");
      grants.push(`${actions} ${scope}`);
    }
    return grants.sort();
  });

describe(
  "Azure AI Search index bindings on an Azure Function",
  { tags: ["provider:azure", "live"] },
  () => {
    describe("Search.SearchDocuments", () => {
      test(
        "finds the seeded document by full-text search",
        Effect.gen(function* () {
          yield* seedCatalog;
          const body = yield* call("/search");
          expectOk(body);
          expect(body.result).toEqual({ count: 1, hits: [{ id: "1", name: "Seaside Inn" }] });
        }),
        { timeout: 420_000 },
      );
    });

    describe("Search.GetDocument", () => {
      test(
        "looks up a document by key; a missing key is NotFound",
        Effect.gen(function* () {
          yield* seedCatalog;
          const body = yield* call("/get");
          expectOk(body);
          expect(body.result).toEqual({
            document: { id: "2", name: "Seaview Lodge" },
            missing: "NotFound",
          });
        }),
        { timeout: 420_000 },
      );
    });

    describe("Search.CountDocuments", () => {
      test(
        "counts the seeded documents",
        Effect.gen(function* () {
          yield* seedCatalog;
          const body = yield* call("/count");
          expectOk(body);
          expect(body.result).toEqual({ count: CATALOG_DOCUMENTS.length });
        }),
        { timeout: 420_000 },
      );
    });

    describe("Search.SuggestDocuments", () => {
      test(
        "suggests the documents whose names start with the text",
        Effect.gen(function* () {
          yield* seedCatalog;
          const body = yield* call("/suggest");
          expectOk(body);
          expect(body.result).toEqual({ ids: ["1", "2"] });
        }),
        { timeout: 420_000 },
      );
    });

    describe("Search.AutocompleteDocuments", () => {
      test(
        "completes the partial term from the suggester field",
        Effect.gen(function* () {
          yield* seedCatalog;
          const body = yield* call("/autocomplete");
          expectOk(body);
          expect(body.result).toEqual({ terms: ["seaside", "seaview"] });
        }),
        { timeout: 420_000 },
      );
    });

    describe("Search.GetIndexStatistics", () => {
      test(
        "reports the seeded document count",
        Effect.gen(function* () {
          yield* seedCatalog;
          const body = yield* call("/stats");
          expectOk(body);
          expect(body.result.documentCount).toEqual(CATALOG_DOCUMENTS.length);
          expect(body.result.storageSize).toBeGreaterThan(0);
        }),
        { timeout: 420_000 },
      );
    });

    describe("Search.SearchIndexRead", () => {
      test(
        "searches, looks up, counts, suggests, and autocompletes",
        Effect.gen(function* () {
          yield* seedCatalog;
          const body = yield* call("/read");
          expectOk(body);
          expect(body.result).toEqual({
            ids: ["3", "1"],
            document: { id: "3", city: "Zermatt" },
            missing: true,
            count: CATALOG_DOCUMENTS.length,
            suggestions: ["1", "2"],
            terms: ["mountain"],
          });
        }),
        { timeout: 420_000 },
      );
    });

    describe("Search.IndexDocuments", () => {
      test(
        "uploads a document the deployer reads back; deleting an absent key succeeds",
        Effect.gen(function* () {
          const body = yield* call("/index?key=via-index");
          expectOk(body);
          expect(body.result).toEqual([
            { key: "via-index", status: true, code: 201 },
            { key: "via-index-absent", status: true, code: 200 },
          ]);
          const document = yield* inboxDocument("via-index");
          expect(document.name).toEqual("Uploaded by IndexDocuments");
        }),
        { timeout: 420_000 },
      );
    });

    describe("Search.SearchIndexWrite", () => {
      test(
        "uploads, merges, merge-or-uploads, and deletes",
        Effect.gen(function* () {
          const body = yield* call("/write?key=via-write");
          expectOk(body);
          expect(body.result).toEqual([
            { key: "via-write", status: true },
            { key: "via-write", status: true },
            { key: "via-write-extra", status: true },
            { key: "via-write-extra", status: true },
          ]);
          const document = yield* inboxDocument("via-write");
          expect({ name: document.name, rating: document.rating }).toEqual({
            name: "Written",
            rating: 2,
          });
          expect(yield* inboxDocument("via-write-extra")).toEqual({ missing: true });
        }),
        { timeout: 420_000 },
      );
    });

    describe("Search.SearchIndexReadWrite", () => {
      test(
        "writes a document and reads it back",
        Effect.gen(function* () {
          const body = yield* call("/read-write?key=via-read-write");
          expectOk(body);
          expect(body.result).toEqual({ name: "Read and written" });
          const document = yield* inboxDocument("via-read-write");
          expect(document.name).toEqual("Read and written");
        }),
        { timeout: 420_000 },
      );
    });

    describe("AzureBindings.Bind least privilege", () => {
      test(
        "assigns exactly each binding's actions, scoped to the bound index",
        Effect.gen(function* () {
          const outputs = yield* stack;
          expect(outputs.principalId).toMatch(/^[0-9a-f-]{36}$/);
          const grants = yield* grantsOf(outputs.principalId!).pipe(Effect.provide(azure));
          const catalog = outputs.catalogId.toLowerCase();
          const inbox = outputs.inboxId.toLowerCase();
          expect(grants).toEqual(
            [
              `documents/read ${catalog}`,
              `read ${catalog}`,
              `documents/read ${inbox}`,
              `documents/delete+documents/write ${inbox}`,
            ].sort(),
          );
        }),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then check every role assigned to the Function's identity is gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId } = yield* stack;
    yield* destroy(Stack);
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    // The role-assignment list trails deletes on index scopes by over a minute.
    const remaining = yield* assignmentsOf(principalId!).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 18,
      }),
    );
    expect(remaining.map((a) => a.properties?.scope)).toEqual([]);
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
