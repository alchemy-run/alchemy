import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import CosmosTableFunction, {
  DeleteTable,
  GetTable,
  InsertTable,
  MergeTable,
  QueryTable,
  ReadTable,
  ReadWriteTable,
  TableAccount,
  UpdateTable,
  WriteTable,
} from "./fixtures/table-function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Object ID (`oid` claim) of the identity running the tests. */
const deployerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureCosmosTableBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* CosmosTableFunction;
    const account = yield* TableAccount;
    const named = {
      get: yield* GetTable,
      query: yield* QueryTable,
      insert: yield* InsertTable,
      update: yield* UpdateTable,
      merge: yield* MergeTable,
      delete: yield* DeleteTable,
      read: yield* ReadTable,
      write: yield* WriteTable,
      readWrite: yield* ReadWriteTable,
    };
    // The deployer seeds and reads entities out of band.
    const deployer = yield* deployerObjectId.pipe(Effect.orDie);
    yield* Azure.CosmosDB.TableRoleAssignment("CosmosTableBindingsDeployer", {
      account: account.accountName,
      // Cosmos DB Built-in Data Contributor, on the whole account.
      roleDefinitionId: "00000000-0000-0000-0000-000000000002",
      principalId: deployer,
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      resourceGroup: account.resourceGroup,
      accountName: account.accountName,
      tableNames: {
        get: named.get.tableName,
        query: named.query.tableName,
        insert: named.insert.tableName,
        update: named.update.tableName,
        merge: named.merge.tableName,
        delete: named.delete.tableName,
        read: named.read.tableName,
        write: named.write.tableName,
        readWrite: named.readWrite.tableName,
      },
    };
  }),
);

type TableKey =
  | "get"
  | "query"
  | "insert"
  | "update"
  | "merge"
  | "delete"
  | "read"
  | "write"
  | "readWrite";

// Serverless Cosmos DB account in centralus (~$0 idle) + a Flex Consumption
// app; ~3 min account create, ~8 min delete, ~15 min per run.
const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

/** Azure credentials and environment for out-of-band calls. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and Cosmos DB data-role propagation, then return the last
 * answer so a real failure shows its Cosmos DB error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 72 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** The deployer's data role can trail the deploy by a few minutes. */
const whileDenied = {
  while: (e: { readonly _tag: string }) => e._tag === "TablePermissionDenied",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

/** OData key literal: single quotes doubled. */
const quote = (key: string) => key.replace(/'/g, "''");

/** Out-of-band entity access as the deployer (not the Function's identity). */
const oob = (key: TableKey) =>
  Effect.gen(function* () {
    const { accountName, tableNames } = yield* stack;
    const url = `https://${accountName}.table.cosmos.azure.com`;
    const table = tableNames[key];
    return {
      put: (PartitionKey: string, RowKey: string, properties: Record<string, unknown> = {}) =>
        tables
          .UpdateTableEntity({
            url,
            table,
            partitionKey: quote(PartitionKey),
            rowKey: quote(RowKey),
            body: { PartitionKey, RowKey, ...properties },
          })
          .pipe(Effect.retry(whileDenied), Effect.provide(azure)),
      remove: (partitionKey: string, rowKey: string) =>
        tables
          .DeleteTableEntity({
            url,
            table,
            partitionKey: quote(partitionKey),
            rowKey: quote(rowKey),
            ifMatch: "*",
          })
          .pipe(
            Effect.catchTag("TableEntityNotFound", () => Effect.void),
            Effect.retry(whileDenied),
            Effect.provide(azure),
          ),
      get: (partitionKey: string, rowKey: string) =>
        tables
          .TableQueryEntityWithPartitionAndRowKey({
            url,
            table,
            partitionKey: quote(partitionKey),
            rowKey: quote(rowKey),
          })
          .pipe(
            Effect.map((entity) => {
              const {
                "odata.metadata": _m,
                "odata.etag": _e,
                Timestamp: _t,
                ...rest
              } = entity as Record<string, unknown>;
              return rest as Record<string, unknown> | undefined;
            }),
            Effect.catchTag("TableEntityNotFound", () => Effect.succeed(undefined)),
            Effect.retry(whileDenied),
            Effect.provide(azure),
          ),
    };
  });

const live = { timeout: 600_000 };

describe(
  "Azure Cosmos DB for Table bindings on an Azure Function",
  { tags: ["provider:azure", "live"] },
  () => {
    describe("GetTableEntity", () => {
      test(
        "reads an entity and types a missing one as TableEntityNotFound",
        Effect.gen(function* () {
          const table = yield* oob("get");
          yield* table.put("p", "it's-1", { value: "seeded" });
          const body = yield* call(`/entity/get?pk=p&rk=${encodeURIComponent("it's-1")}`);
          expectOk(body);
          expect(body.result).toEqual({ value: "seeded", missing: "TableEntityNotFound" });
        }),
        live,
      );
    });

    describe("QueryTableEntities", () => {
      test(
        "returns only the filtered partition",
        Effect.gen(function* () {
          const table = yield* oob("query");
          yield* table.put("q", "r1", { value: "a" });
          yield* table.put("q", "r2", { value: "b" });
          yield* table.put("other", "r1", { value: "c" });
          const body = yield* call("/entity/query?pk=q");
          expectOk(body);
          expect(body.result).toEqual({ rows: ["r1", "r2"] });
        }),
        live,
      );
    });

    describe("InsertTableEntity", () => {
      test(
        "inserts an entity and types a duplicate as TableEntityAlreadyExists",
        Effect.gen(function* () {
          // A kept stack (NO_DESTROY) still holds the last run's entity.
          const table = yield* oob("insert");
          yield* table.remove("i", "r1");
          const body = yield* call("/entity/insert?pk=i&rk=r1&value=inserted");
          expectOk(body);
          expect(body.result).toEqual({ value: "inserted", again: "TableEntityAlreadyExists" });
          expect(yield* table.get("i", "r1")).toEqual({
            PartitionKey: "i",
            RowKey: "r1",
            value: "inserted",
          });
        }),
        live,
      );
    });

    describe("UpdateTableEntity", () => {
      test(
        "replaces an entity",
        Effect.gen(function* () {
          const table = yield* oob("update");
          yield* table.put("u", "r1", { value: "old", dropped: "yes" });
          const body = yield* call("/entity/update?pk=u&rk=r1&value=new");
          expectOk(body);
          expect(body.result).toEqual({ hasEtag: true });
          expect(yield* table.get("u", "r1")).toEqual({
            PartitionKey: "u",
            RowKey: "r1",
            value: "new",
          });
        }),
        live,
      );
    });

    describe("MergeTableEntity", () => {
      test(
        "merges into an entity and keeps its other properties",
        Effect.gen(function* () {
          const table = yield* oob("merge");
          yield* table.put("m", "r1", { value: "kept" });
          const body = yield* call("/entity/merge?pk=m&rk=r1&value=added");
          expectOk(body);
          expect(body.result).toEqual({ hasEtag: true });
          expect(yield* table.get("m", "r1")).toEqual({
            PartitionKey: "m",
            RowKey: "r1",
            value: "kept",
            merged: "added",
          });
        }),
        live,
      );
    });

    describe("DeleteTableEntity", () => {
      test(
        "deletes an entity and types a second delete as TableEntityNotFound",
        Effect.gen(function* () {
          const table = yield* oob("delete");
          yield* table.put("d", "r1", { value: "doomed" });
          const body = yield* call("/entity/delete?pk=d&rk=r1");
          expectOk(body);
          expect(body.result).toEqual({ again: "TableEntityNotFound" });
          expect(yield* table.get("d", "r1")).toEqual(undefined);
        }),
        live,
      );
    });

    describe("TableRead", () => {
      test(
        "gets, misses, and queries entities",
        Effect.gen(function* () {
          const table = yield* oob("read");
          yield* table.put("rd", "a", { value: "first", n: 1 });
          yield* table.put("rd", "b", { value: "second" });
          const body = yield* call("/read?pk=rd&rk=a");
          expectOk(body);
          expect(body.result).toEqual({
            entity: { PartitionKey: "rd", RowKey: "a", value: "first", n: 1 },
            hasEtag: true,
            missing: true,
            queried: ["a", "b"],
          });
        }),
        live,
      );
    });

    describe("TableWrite", () => {
      test(
        "upserts, merges with an ETag, and deletes",
        Effect.gen(function* () {
          const body = yield* call("/write?pk=w&rk=r1&value=written");
          expectOk(body);
          expect(body.result).toEqual({ inserted: "TableEntityAlreadyExists" });
          const table = yield* oob("write");
          expect(yield* table.get("w", "r1")).toEqual(undefined);
          expect(yield* table.get("w", "r1-kept")).toEqual({
            PartitionKey: "w",
            RowKey: "r1-kept",
            value: "written",
          });
        }),
        live,
      );
    });

    describe("TableReadWrite", () => {
      test(
        "round-trips an entity through every operation",
        Effect.gen(function* () {
          const body = yield* call("/readwrite?pk=rw&rk=r1");
          expectOk(body);
          expect(body.result).toEqual({
            first: 1,
            second: 2,
            stale: "TableEntityConditionNotMet",
            queried: ["r1"],
            gone: true,
          });
          const table = yield* oob("readWrite");
          expect(yield* table.get("rw", "r1")).toEqual(undefined);
        }),
        live,
      );
    });

    describe("least privilege", () => {
      test(
        "assigns one data role per binding, scoped to its table, with exactly its actions",
        Effect.gen(function* () {
          const out = yield* stack;
          expect(out.principalId).toMatch(/^[0-9a-f-]{36}$/);
          const { subscriptionId } = yield* Azure.AzureEnvironment.current;
          const where = {
            subscriptionId,
            resourceGroupName: out.resourceGroup,
            accountName: out.accountName,
          };
          const page = yield* cosmos.ListTableResourceTableRoleAssignments(where);
          const mine = (page.value ?? []).filter(
            (a) => a.properties?.principalId === out.principalId,
          );
          const granted: string[] = [];
          for (const assignment of mine) {
            const table = assignment.properties?.scope?.split("/colls/")[1]?.toLowerCase() ?? "";
            const roleDefinitionId =
              assignment.properties?.roleDefinitionId?.split("/").pop() ?? "";
            const role = yield* cosmos.GetTableResourceTableRoleDefinition({
              ...where,
              roleDefinitionId,
            });
            const actions = (role.properties?.permissions ?? [])
              .flatMap((p) => p.dataActions ?? [])
              .map((a) => a.replace("Microsoft.DocumentDB/databaseAccounts/", ""))
              .sort();
            granted.push(`${table} ${actions.join(" ")}`);
          }
          const names = out.tableNames;
          const entities = "tables/containers/entities";
          const query = "tables/containers/executeQuery";
          // MERGE runs as the system stored procedure `__.sys.tablesBatchOperation`.
          const sproc = "tables/containers/executeStoredProcedure";
          const meta = "readMetadata";
          const grant = (key: TableKey, ...actions: string[]) =>
            `${names[key].toLowerCase()} ${[meta, ...actions].sort().join(" ")}`;
          expect(granted.sort()).toEqual(
            [
              grant("get", `${entities}/read`),
              grant("query", query),
              grant("insert", `${entities}/create`),
              grant("update", `${entities}/upsert`, `${entities}/replace`),
              grant("merge", sproc),
              grant("delete", `${entities}/delete`),
              grant("read", `${entities}/read`, query),
              grant(
                "write",
                `${entities}/create`,
                `${entities}/upsert`,
                `${entities}/replace`,
                `${entities}/delete`,
                sproc,
              ),
              grant(
                "readWrite",
                `${entities}/read`,
                query,
                `${entities}/create`,
                `${entities}/upsert`,
                `${entities}/replace`,
                `${entities}/delete`,
                sproc,
              ),
            ].sort(),
          );
        }).pipe(Effect.provide(azure)),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then prove the account (and with it every data role) is gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { resourceGroup, accountName } = yield* stack;
    yield* destroy(Stack);
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const gone = yield* cosmos
      .GetDatabaseAccount({ subscriptionId, resourceGroupName: resourceGroup, accountName })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
          Effect.succeed("gone" as const),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (status) => status === "gone",
          times: 30,
        }),
      );
    expect(gone).toEqual("gone");
  }).pipe(Effect.provide(azure)),
  { timeout: 1_200_000 },
);
