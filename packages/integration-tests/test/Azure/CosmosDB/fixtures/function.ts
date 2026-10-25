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

export const Account = Azure.CosmosDB.DatabaseAccount("CosmosBindingsAccount", {
  // Serverless accounts provision in about a minute in centralus (25+ in eastus).
  location: "centralus",
  capabilities: ["EnableServerless"],
});
export const Database = Effect.gen(function* () {
  const account = yield* Account;
  return yield* Azure.CosmosDB.SqlDatabase("CosmosBindingsDatabase", {
    account: account.accountName,
  });
});
/** Every binding route works on this container, partitioned by `/tenant`. */
export const Items = Effect.gen(function* () {
  const account = yield* Account;
  const database = yield* Database;
  return yield* Azure.CosmosDB.SqlContainer("CosmosBindingsItems", {
    account: account.accountName,
    database: database.databaseName,
    partitionKey: { paths: ["/tenant"] },
  });
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

type Doc = { id?: unknown; tenant?: unknown; value?: unknown };
const ids = (documents: readonly unknown[] | undefined) =>
  (documents ?? []).map((d) => String((d as Doc).id)).sort();
const valueOf = (document: unknown) => (document as Doc | undefined)?.value;

/**
 * Effect Function with one route per Cosmos DB for NoSQL binding. Each
 * route takes `id`, `tenant` (the partition key value) and, for writes,
 * `value`; documents are `{ id, tenant, value }`. Routes answer
 * `{ ok, result | error }` with a 500 on error, so a caller retries through
 * data-role propagation and a real failure shows the Cosmos DB error.
 */
export default class CosmosBindingsFunction extends Azure.Functions.Function<CosmosBindingsFunction>()(
  "CosmosBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const items = yield* Items;
    const createDocument = yield* Azure.CosmosDB.CreateDocument(items);
    const deleteDocument = yield* Azure.CosmosDB.DeleteDocument(items);
    const getDocument = yield* Azure.CosmosDB.GetDocument(items);
    const listDocuments = yield* Azure.CosmosDB.ListDocuments(items);
    const patchDocument = yield* Azure.CosmosDB.PatchDocument(items);
    const queryDocuments = yield* Azure.CosmosDB.QueryDocuments(items);
    const replaceDocument = yield* Azure.CosmosDB.ReplaceDocument(items);
    const upsertDocument = yield* Azure.CosmosDB.UpsertDocument(items);
    const read = yield* Azure.CosmosDB.SqlContainerRead(items);
    const write = yield* Azure.CosmosDB.SqlContainerWrite(items);
    const readWrite = yield* Azure.CosmosDB.SqlContainerReadWrite(items);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const id = url.searchParams.get("id") ?? "";
        const tenant = url.searchParams.get("tenant") ?? "";
        const value = url.searchParams.get("value") ?? "";
        const partitionKey = [tenant];
        const byTenant = {
          query: "SELECT * FROM c WHERE c.tenant = @tenant",
          parameters: [{ name: "@tenant", value: tenant }],
          partitionKey,
        };
        switch (url.pathname) {
          case "/create":
            return yield* respond(
              Effect.map(
                createDocument({ document: { id, tenant, value }, partitionKey }),
                (res) => ({ id: (res.document as Doc | undefined)?.id, etag: res.etag }),
              ),
            );
          case "/delete":
            return yield* respond(
              Effect.map(deleteDocument({ documentId: id, partitionKey }), () => ({
                deleted: id,
              })),
            );
          case "/get":
            return yield* respond(
              Effect.map(getDocument({ documentId: id, partitionKey }), (res) => ({
                value: valueOf(res.document),
                etag: res.etag,
              })),
            );
          case "/list":
            return yield* respond(
              Effect.map(listDocuments({ partitionKey }), (page) => ({
                ids: ids(page.Documents),
                count: page._count,
              })),
            );
          case "/patch":
            return yield* respond(
              Effect.map(
                patchDocument({
                  documentId: id,
                  partitionKey,
                  operations: [{ op: "set", path: "/value", value }],
                }),
                (res) => ({ value: valueOf(res.document) }),
              ),
            );
          case "/query":
            return yield* respond(
              Effect.map(queryDocuments(byTenant), (page) => ({ ids: ids(page.Documents) })),
            );
          case "/replace":
            return yield* respond(
              Effect.map(
                replaceDocument({ documentId: id, document: { id, tenant, value }, partitionKey }),
                (res) => ({ value: valueOf(res.document) }),
              ),
            );
          case "/upsert":
            return yield* respond(
              Effect.map(
                upsertDocument({ document: { id, tenant, value }, partitionKey }),
                (res) => ({ value: valueOf(res.document) }),
              ),
            );
          case "/read":
            return yield* respond(
              Effect.gen(function* () {
                const got = yield* read.get({ documentId: id, partitionKey });
                const listed = yield* read.list({ partitionKey });
                const queried = yield* read.query(byTenant);
                return {
                  value: valueOf(got.document),
                  listed: ids(listed.Documents),
                  queried: ids(queried.Documents),
                };
              }),
            );
          case "/write":
            return yield* respond(
              Effect.gen(function* () {
                // `<id>` ends as `value` after every write kind; `<id>-gone` is deleted.
                yield* write.create({ document: { id, tenant, value: "created" }, partitionKey });
                yield* write.upsert({ document: { id, tenant, value: "upserted" }, partitionKey });
                yield* write.replace({
                  documentId: id,
                  document: { id, tenant, value: "replaced" },
                  partitionKey,
                });
                const patched = yield* write.patch({
                  documentId: id,
                  partitionKey,
                  operations: [{ op: "set", path: "/value", value }],
                });
                const gone = `${id}-gone`;
                yield* write.create({ document: { id: gone, tenant, value }, partitionKey });
                yield* write.delete({ documentId: gone, partitionKey });
                return { value: valueOf(patched.document) };
              }),
            );
          case "/read-write":
            return yield* respond(
              Effect.gen(function* () {
                yield* readWrite.upsert({ document: { id, tenant, value }, partitionKey });
                const got = yield* readWrite.get({ documentId: id, partitionKey });
                const queried = yield* readWrite.query(byTenant);
                const patched = yield* readWrite.patch({
                  documentId: id,
                  partitionKey,
                  operations: [{ op: "set", path: "/value", value: `${value}-patched` }],
                });
                yield* readWrite.delete({ documentId: id, partitionKey });
                const missing = yield* readWrite.get({ documentId: id, partitionKey }).pipe(
                  Effect.as(false),
                  Effect.catchTag("CosmosNotFound", () => Effect.succeed(true)),
                );
                return {
                  value: valueOf(got.document),
                  queried: ids(queried.Documents),
                  patched: valueOf(patched.document),
                  missing,
                };
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
        Azure.CosmosDB.CreateDocumentHttp,
        Azure.CosmosDB.DeleteDocumentHttp,
        Azure.CosmosDB.GetDocumentHttp,
        Azure.CosmosDB.ListDocumentsHttp,
        Azure.CosmosDB.PatchDocumentHttp,
        Azure.CosmosDB.QueryDocumentsHttp,
        Azure.CosmosDB.ReplaceDocumentHttp,
        Azure.CosmosDB.UpsertDocumentHttp,
        Azure.CosmosDB.SqlContainerReadHttp,
        Azure.CosmosDB.SqlContainerWriteHttp,
        Azure.CosmosDB.SqlContainerReadWriteHttp,
      ),
    ),
  ),
) {}
