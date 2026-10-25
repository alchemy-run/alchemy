import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./distilled-source.ts";

// Resources the Cosmos DB for Table fixture binds. Module-scope so the test
// stack yields the same declarations.

export const TableAccount = Azure.CosmosDB.DatabaseAccount("CosmosTableBindingsAccount", {
  // Serverless accounts provision in about a minute in centralus (25+ in eastus).
  location: "centralus",
  capabilities: ["EnableTable", "EnableServerless"],
});

const table = (id: string) =>
  Effect.gen(function* () {
    const account = yield* TableAccount;
    return yield* Azure.CosmosDB.Table(id, { account: account.accountName });
  });

// One table per binding, so each data role is proven on its own scope.
export const GetTable = table("CtGet");
export const QueryTable = table("CtQuery");
export const InsertTable = table("CtInsert");
export const UpdateTable = table("CtUpdate");
export const MergeTable = table("CtMerge");
export const DeleteTable = table("CtDelete");
export const ReadTable = table("CtRead");
export const WriteTable = table("CtWrite");
export const ReadWriteTable = table("CtReadWrite");

/**
 * Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers
 * retry. A `TablePermissionDenied` also answers its `odata.error` body,
 * which names the data action Cosmos DB checked.
 */
const respond = <E>(effect: Effect.Effect<unknown, E, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchIf(
      (e: E) =>
        typeof e === "object" &&
        e !== null &&
        "_tag" in e &&
        e._tag === "TablePermissionDenied" &&
        "body" in e,
      (e) => HttpServerResponse.json({ ok: false, error: JSON.stringify(e) }, { status: 500 }),
    ),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * The tag of a typed failure (or `"ok"`). A missing data role
 * (`TablePermissionDenied`, while a new assignment propagates) stays a
 * failure so the caller retries.
 */
const tagOf = <E extends { readonly _tag: string }>(
  effect: Effect.Effect<unknown, E, RuntimeContext>,
) =>
  effect.pipe(
    Effect.as("ok"),
    Effect.catchIf(
      (e: E) => e._tag !== "TablePermissionDenied",
      (e) => Effect.succeed(e._tag),
    ),
  );

const strip = (entity: Record<string, unknown> | undefined) => {
  if (entity === undefined) return undefined;
  const { Timestamp: _timestamp, etag: _etag, ...rest } = entity;
  return rest;
};

/**
 * Effect Function with one route per Cosmos DB for Table binding. Routes
 * answer `{ ok, result | error }` with a 500 on error, so a caller retries
 * through data-role propagation and a real failure shows the Cosmos DB
 * error.
 */
export default class CosmosTableFunction extends Azure.Functions.Function<CosmosTableFunction>()(
  "CosmosTableBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const getTable = yield* GetTable;
    const queryTable = yield* QueryTable;
    const insertTable = yield* InsertTable;
    const updateTable = yield* UpdateTable;
    const mergeTable = yield* MergeTable;
    const deleteTable = yield* DeleteTable;
    const readTable = yield* ReadTable;
    const writeTable = yield* WriteTable;
    const readWriteTable = yield* ReadWriteTable;

    const getEntity = yield* Azure.CosmosDB.GetTableEntity(getTable);
    const queryEntities = yield* Azure.CosmosDB.QueryTableEntities(queryTable);
    const insertEntity = yield* Azure.CosmosDB.InsertTableEntity(insertTable);
    const updateEntity = yield* Azure.CosmosDB.UpdateTableEntity(updateTable);
    const mergeEntity = yield* Azure.CosmosDB.MergeTableEntity(mergeTable);
    const deleteEntity = yield* Azure.CosmosDB.DeleteTableEntity(deleteTable);
    const read = yield* Azure.CosmosDB.TableRead(readTable);
    const write = yield* Azure.CosmosDB.TableWrite(writeTable);
    const readWrite = yield* Azure.CosmosDB.TableReadWrite(readWriteTable);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const pk = url.searchParams.get("pk") ?? "";
        const rk = url.searchParams.get("rk") ?? "";
        const value = url.searchParams.get("value") ?? "";
        switch (url.pathname) {
          case "/entity/get":
            return yield* respond(
              Effect.gen(function* () {
                const found = yield* getEntity({ partitionKey: pk, rowKey: rk });
                const missing = yield* tagOf(
                  getEntity({ partitionKey: pk, rowKey: `${rk}-missing` }),
                );
                return { value: found.value, missing };
              }),
            );
          case "/entity/query":
            return yield* respond(
              Effect.map(
                queryEntities({ _filter: `PartitionKey eq '${pk}'`, _select: "RowKey,value" }),
                (page) => ({ rows: (page.value ?? []).map((e) => e.RowKey).sort() }),
              ),
            );
          case "/entity/insert":
            return yield* respond(
              Effect.gen(function* () {
                const created = yield* insertEntity({
                  body: { PartitionKey: pk, RowKey: rk, value },
                });
                const again = yield* tagOf(
                  insertEntity({ body: { PartitionKey: pk, RowKey: rk, value } }),
                );
                return { value: created.value, again };
              }),
            );
          case "/entity/update":
            return yield* respond(
              Effect.map(
                updateEntity({
                  partitionKey: pk,
                  rowKey: rk,
                  body: { PartitionKey: pk, RowKey: rk, value },
                }),
                (written) => ({ hasEtag: typeof written.eTag === "string" }),
              ),
            );
          case "/entity/merge":
            return yield* respond(
              Effect.map(
                mergeEntity({ partitionKey: pk, rowKey: rk, body: { merged: value } }),
                (written) => ({ hasEtag: typeof written.eTag === "string" }),
              ),
            );
          case "/entity/delete":
            return yield* respond(
              Effect.gen(function* () {
                yield* deleteEntity({ partitionKey: pk, rowKey: rk, ifMatch: "*" });
                const again = yield* tagOf(
                  deleteEntity({ partitionKey: pk, rowKey: rk, ifMatch: "*" }),
                );
                return { again };
              }),
            );
          case "/read":
            return yield* respond(
              Effect.gen(function* () {
                const found = yield* read.get(pk, rk);
                const missing = yield* read.get(pk, `${rk}-missing`);
                const page = yield* read.query({ filter: `PartitionKey eq '${pk}'` });
                return {
                  entity: strip(found),
                  hasEtag: typeof found?.etag === "string",
                  missing: missing === undefined,
                  queried: page.entities.map((e) => e.RowKey).sort(),
                };
              }),
            );
          case "/write":
            return yield* respond(
              Effect.gen(function* () {
                const upserted = yield* write.upsert({ PartitionKey: pk, RowKey: rk, value });
                yield* write.update(
                  { PartitionKey: pk, RowKey: rk, extra: "merged" },
                  { etag: upserted.etag, mode: "merge" },
                );
                const kept = `${rk}-kept`;
                yield* write.upsert({ PartitionKey: pk, RowKey: kept, value });
                yield* write.delete(pk, rk);
                yield* write.delete(pk, rk);
                const inserted = yield* tagOf(
                  write.insert({ PartitionKey: pk, RowKey: kept, value }),
                );
                return { inserted };
              }),
            );
          case "/readwrite":
            return yield* respond(
              Effect.gen(function* () {
                yield* readWrite.upsert({ PartitionKey: pk, RowKey: rk, n: 1 });
                const first = yield* readWrite.get(pk, rk);
                yield* readWrite.update(
                  { PartitionKey: pk, RowKey: rk, n: 2 },
                  { etag: first?.etag },
                );
                const second = yield* readWrite.get(pk, rk);
                const stale = yield* tagOf(
                  readWrite.update({ PartitionKey: pk, RowKey: rk, n: 3 }, { etag: first?.etag }),
                );
                const page = yield* readWrite.query({ filter: `PartitionKey eq '${pk}'` });
                yield* readWrite.delete(pk, rk, { etag: second?.etag });
                const gone = yield* readWrite.get(pk, rk);
                return {
                  first: first?.n,
                  second: second?.n,
                  stale,
                  queried: page.entities.map((e) => e.RowKey),
                  gone: gone === undefined,
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
        Azure.CosmosDB.GetTableEntityHttp,
        Azure.CosmosDB.QueryTableEntitiesHttp,
        Azure.CosmosDB.InsertTableEntityHttp,
        Azure.CosmosDB.UpdateTableEntityHttp,
        Azure.CosmosDB.MergeTableEntityHttp,
        Azure.CosmosDB.DeleteTableEntityHttp,
        Azure.CosmosDB.TableReadHttp,
        Azure.CosmosDB.TableWriteHttp,
        Azure.CosmosDB.TableReadWriteHttp,
      ),
    ),
  ),
) {}
