import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
// TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the table-binding fixture consumes. Module-scope so the test can
// yield the same declarations.
export const TableData = Azure.Storage.StorageAccount("TableBindingsData");

const table = (id: string) =>
  Effect.gen(function* () {
    const account = yield* TableData;
    return yield* Azure.Storage.Table(id, { storageAccount: account.storageAccountName });
  });

// One table per binding, so each role is proven on its own scope.
export const GetTable = table("TbGet");
export const QueryTable = table("TbQuery");
export const InsertTable = table("TbInsert");
export const UpdateTable = table("TbUpdate");
export const MergeTable = table("TbMerge");
export const DeleteTable = table("TbDelete");
export const ReadTable = table("TbRead");
export const WriteTable = table("TbWrite");
export const ReadWriteTable = table("TbReadWrite");

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * The tag of a typed failure (or `"ok"`). A missing role
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
 * Effect-native Azure Function with one route per `cosmos-tables` binding.
 * Routes answer `{ ok, result | error }` with a 500 on error, so a caller
 * retries through role propagation and a real failure shows the Azure
 * error.
 */
export default class TableFunction extends Azure.Functions.Function<TableFunction>()(
  "TableBindingsFunction",
  {
    main: import.meta.url,
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const account = yield* TableData;
    const getTable = yield* GetTable;
    const queryTable = yield* QueryTable;
    const insertTable = yield* InsertTable;
    const updateTable = yield* UpdateTable;
    const mergeTable = yield* MergeTable;
    const deleteTable = yield* DeleteTable;
    const readTable = yield* ReadTable;
    const writeTable = yield* WriteTable;
    const readWriteTable = yield* ReadWriteTable;

    const getEntity = yield* Azure.Storage.GetTableEntity(getTable);
    const queryEntities = yield* Azure.Storage.QueryTableEntities(queryTable);
    const insertEntity = yield* Azure.Storage.InsertTableEntity(insertTable);
    const updateEntity = yield* Azure.Storage.UpdateTableEntity(updateTable);
    const mergeEntity = yield* Azure.Storage.MergeTableEntity(mergeTable);
    const deleteEntity = yield* Azure.Storage.DeleteTableEntity(deleteTable);
    const createTables = yield* Azure.Storage.CreateTable(account);
    const deleteTables = yield* Azure.Storage.DeleteTable(account);
    const queryTables = yield* Azure.Storage.QueryTables(account);
    const read = yield* Azure.Storage.TableRead(readTable);
    const write = yield* Azure.Storage.TableWrite(writeTable);
    const readWrite = yield* Azure.Storage.TableReadWrite(readWriteTable);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const pk = url.searchParams.get("pk") ?? "";
        const rk = url.searchParams.get("rk") ?? "";
        const value = url.searchParams.get("value") ?? "";
        const name = url.searchParams.get("name") ?? "";
        switch (url.pathname) {
          case "/entity/get":
            return yield* respond(
              Effect.gen(function* () {
                const found = yield* getEntity({ partitionKey: pk, rowKey: rk });
                const missing = yield* tagOf(
                  getEntity({ partitionKey: pk, rowKey: `${rk}-missing` }),
                );
                return {
                  value: found.value,
                  hasEtag: typeof found["odata.etag"] === "string",
                  missing,
                };
              }),
            );
          case "/entity/query":
            return yield* respond(
              Effect.gen(function* () {
                const first = yield* queryEntities({
                  _filter: `PartitionKey eq '${pk}'`,
                  _top: 1,
                  _select: "RowKey,value",
                });
                const second = yield* queryEntities({
                  _filter: `PartitionKey eq '${pk}'`,
                  _top: 1,
                  _select: "RowKey,value",
                  NextPartitionKey: first.xMsContinuationNextPartitionKey,
                  NextRowKey: first.xMsContinuationNextRowKey,
                });
                return {
                  first: (first.value ?? []).map((e) => e.RowKey),
                  second: (second.value ?? []).map((e) => e.RowKey),
                  hasMore: first.xMsContinuationNextPartitionKey !== undefined,
                };
              }),
            );
          case "/entity/insert":
            return yield* respond(
              Effect.map(
                insertEntity({ body: { PartitionKey: pk, RowKey: rk, value } }),
                (created) => ({ value: created.value }),
              ),
            );
          case "/entity/insert-again":
            return yield* respond(
              tagOf(insertEntity({ body: { PartitionKey: pk, RowKey: rk, value } })),
            );
          case "/entity/update":
            return yield* respond(
              Effect.gen(function* () {
                // No If-Match: insert or replace.
                const upserted = yield* updateEntity({
                  partitionKey: pk,
                  rowKey: rk,
                  body: { PartitionKey: pk, RowKey: rk, value },
                });
                const stale = yield* tagOf(
                  updateEntity({
                    partitionKey: pk,
                    rowKey: rk,
                    ifMatch: `W/"datetime'2020-01-01T00%3A00%3A00.0000000Z'"`,
                    body: { PartitionKey: pk, RowKey: rk, value: "stale" },
                  }),
                );
                const missing = yield* tagOf(
                  updateEntity({
                    partitionKey: pk,
                    rowKey: `${rk}-missing`,
                    ifMatch: "*",
                    body: { PartitionKey: pk, RowKey: `${rk}-missing` },
                  }),
                );
                return { etag: upserted.eTag, stale, missing };
              }),
            );
          case "/entity/merge":
            return yield* respond(
              Effect.map(
                mergeEntity({ partitionKey: pk, rowKey: rk, body: { merged: value } }),
                (written) => ({ etag: written.eTag }),
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
          case "/tables/create":
            return yield* respond(
              Effect.gen(function* () {
                const created = yield* createTables({ TableName: name });
                const again = yield* tagOf(createTables({ TableName: name }));
                return { tableName: created.TableName, again };
              }),
            );
          case "/tables/list":
            return yield* respond(
              Effect.map(queryTables({}), (page) => ({
                names: (page.value ?? []).map((t) => t.TableName),
              })),
            );
          case "/tables/delete":
            return yield* respond(
              Effect.gen(function* () {
                yield* deleteTables({ table: name });
                const again = yield* tagOf(deleteTables({ table: name }));
                return { again };
              }),
            );
          case "/read":
            return yield* respond(
              Effect.gen(function* () {
                const found = yield* read.get(pk, rk);
                const missing = yield* read.get(pk, `${rk}-missing`);
                const page = yield* read.query({ filter: `PartitionKey eq '${pk}'`, top: 1 });
                return {
                  entity: strip(found),
                  hasEtag: typeof found?.etag === "string",
                  missing: missing === undefined,
                  queried: page.entities.map((e) => e.RowKey),
                  hasMore: page.continuation !== undefined,
                };
              }),
            );
          case "/write":
            return yield* respond(
              Effect.gen(function* () {
                const upserted = yield* write.upsert({ PartitionKey: pk, RowKey: rk, value });
                const merged = yield* write.update(
                  { PartitionKey: pk, RowKey: rk, extra: "merged" },
                  { etag: upserted.etag, mode: "merge" },
                );
                const stale = yield* tagOf(
                  write.update(
                    { PartitionKey: pk, RowKey: rk, value: "stale" },
                    { etag: upserted.etag },
                  ),
                );
                const kept = `${rk}-kept`;
                yield* write.upsert({ PartitionKey: pk, RowKey: kept, value });
                yield* write.delete(pk, rk);
                // Deleting a missing entity without an ETag succeeds.
                yield* write.delete(pk, rk);
                return {
                  etagChanged: merged.etag !== undefined && merged.etag !== upserted.etag,
                  stale,
                };
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
                const inserted = yield* tagOf(
                  readWrite.insert({ PartitionKey: pk, RowKey: rk, n: 3 }),
                );
                const page = yield* readWrite.query({ filter: `PartitionKey eq '${pk}'` });
                yield* readWrite.delete(pk, rk, { etag: second?.etag });
                const gone = yield* readWrite.get(pk, rk);
                return {
                  first: first?.n,
                  second: second?.n,
                  inserted,
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
        Azure.Storage.GetTableEntityHttp,
        Azure.Storage.QueryTableEntitiesHttp,
        Azure.Storage.InsertTableEntityHttp,
        Azure.Storage.UpdateTableEntityHttp,
        Azure.Storage.MergeTableEntityHttp,
        Azure.Storage.DeleteTableEntityHttp,
        Azure.Storage.CreateTableHttp,
        Azure.Storage.DeleteTableHttp,
        Azure.Storage.QueryTablesHttp,
        Azure.Storage.TableReadHttp,
        Azure.Storage.TableWriteHttp,
        Azure.Storage.TableReadWriteHttp,
      ),
    ),
  ),
) {}
