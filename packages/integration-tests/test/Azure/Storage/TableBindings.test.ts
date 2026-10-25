import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as tables from "@distilled.cloud/azure/cosmos-tables";
import * as storage from "@distilled.cloud/azure/storage";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import TableFunction, {
  DeleteTable,
  GetTable,
  InsertTable,
  MergeTable,
  QueryTable,
  ReadTable,
  ReadWriteTable,
  TableData,
  UpdateTable,
  WriteTable,
} from "./fixtures/table-function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureStorageTableBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* TableFunction;
    const account = yield* TableData;
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
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      accountName: account.storageAccountName,
      accountId: account.storageAccountId,
      resourceGroup: account.resourceGroup,
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
      tableIds: {
        get: named.get.tableId,
        query: named.query.tableId,
        insert: named.insert.tableId,
        update: named.update.tableId,
        merge: named.merge.tableId,
        delete: named.delete.tableId,
        read: named.read.tableId,
        write: named.write.tableId,
        readWrite: named.readWrite.tableId,
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

// ~$0.01/run (one storage account, 9 tables, a Flex Consumption app); ~6 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Azure credentials and environment for hooks (tests get them from `test.provider`). */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation (custom roles take a few minutes on the
 * data plane), then return the last answer so a real failure shows its
 * Azure error.
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

/** Table endpoint signed with an account SAS the deployer lists through ARM. */
const sasEndpoint = Effect.gen(function* () {
  const { accountName, resourceGroup } = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  const { accountSasToken } = yield* storage.ListStorageAccountAccountSAS({
    subscriptionId,
    resourceGroupName: resourceGroup,
    accountName,
    signedServices: "t",
    signedResourceTypes: "sco",
    signedPermission: "rwdlacu",
    signedProtocol: "https",
    signedExpiry: new Date(Date.now() + 3_600_000).toISOString(),
  });
  return `https://${accountName}.table.core.windows.net/?${accountSasToken}`;
});

/** OData key literal: single quotes doubled. */
const quote = (key: string) => key.replace(/'/g, "''");

/** Out-of-band table access with the account SAS (not the Function's identity). */
const oob = (key: TableKey) =>
  Effect.gen(function* () {
    const { tableNames } = yield* stack;
    const url = yield* sasEndpoint;
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
          .pipe(Effect.provide(azure)),
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
            Effect.provide(azure),
          ),
    };
  }).pipe(Effect.provide(azure));

/** The account's table names, read out of band. */
const tableNamesOob = Effect.gen(function* () {
  const url = yield* sasEndpoint;
  const page = yield* tables.TableQuery({ url });
  return (page.value ?? []).map((t) => t.TableName);
}).pipe(Effect.provide(azure));

const TS = "Microsoft.Storage/storageAccounts/tableServices/tables";

/** One assignment per binding of the fixture. */
const BINDING_GRANTS = 12;

/**
 * `<scope> <sorted actions and data actions>` for every binding role on the
 * Function. Role-assignment lists trail new assignments by a few minutes,
 * so read until all {@link BINDING_GRANTS} show up (bounded).
 */
const grantsOf = (principalId: string, hostStorageAccount: string | undefined) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const bindingAssignments = yield* authorization
      .ListRoleAssignmentForSubscription({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      })
      .pipe(
        // Drop the app's own host-storage grants.
        Effect.map((page) =>
          page.value.filter(
            (a) =>
              !(
                hostStorageAccount &&
                (a.properties?.scope ?? "")
                  .toLowerCase()
                  .endsWith(`/storageaccounts/${hostStorageAccount}`)
              ),
          ),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (assignments) => assignments.length >= BINDING_GRANTS,
          times: 24,
        }),
      );
    const grants: string[] = [];
    const customRoles: string[] = [];
    for (const assignment of bindingAssignments) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      const roleDefinitionId = assignment.properties?.roleDefinitionId?.split("/").pop() ?? "";
      const role = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId,
      });
      if (role.properties?.type === "CustomRole") customRoles.push(roleDefinitionId);
      const permissions = (role.properties?.permissions ?? []).flatMap((p) => [
        ...(p.actions ?? []),
        ...(p.dataActions ?? []),
      ]);
      grants.push(`${scope} ${[...permissions].sort().join(",")}`);
    }
    return { grants: grants.sort(), customRoles };
  });

describe(
  "Azure Storage table bindings on an Azure Function",
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
          expect(body.result).toEqual({
            value: "seeded",
            hasEtag: true,
            missing: "TableEntityNotFound",
          });
        }),
        { timeout: 600_000 },
      );
    });

    describe("QueryTableEntities", () => {
      test(
        "pages a filtered query with continuation tokens",
        Effect.gen(function* () {
          const table = yield* oob("query");
          yield* table.put("q", "r1", { value: "a" });
          yield* table.put("q", "r2", { value: "b" });
          yield* table.put("other", "r1", { value: "c" });
          const body = yield* call("/entity/query?pk=q");
          expectOk(body);
          expect(body.result).toEqual({ first: ["r1"], second: ["r2"], hasMore: true });
        }),
        { timeout: 600_000 },
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
          expect(body.result).toEqual({ value: "inserted" });
          expect(yield* table.get("i", "r1")).toEqual({
            PartitionKey: "i",
            RowKey: "r1",
            value: "inserted",
          });
          const again = yield* call("/entity/insert-again?pk=i&rk=r1&value=again");
          expectOk(again);
          expect(again.result).toEqual("TableEntityAlreadyExists");
        }),
        { timeout: 600_000 },
      );
    });

    describe("UpdateTableEntity", () => {
      test(
        "inserts or replaces, and types stale and missing targets",
        Effect.gen(function* () {
          const table = yield* oob("update");
          yield* table.put("u", "r1", { value: "old", dropped: "yes" });
          const body = yield* call("/entity/update?pk=u&rk=r1&value=new");
          expectOk(body);
          expect(body.result.etag).toMatch(/^W\/"datetime'/);
          expect({ stale: body.result.stale, missing: body.result.missing }).toEqual({
            stale: "TableEntityConditionNotMet",
            missing: "TableEntityNotFound",
          });
          // Replace drops properties not in the body.
          expect(yield* table.get("u", "r1")).toEqual({
            PartitionKey: "u",
            RowKey: "r1",
            value: "new",
          });
        }),
        { timeout: 600_000 },
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
          expect(body.result.etag).toMatch(/^W\/"datetime'/);
          expect(yield* table.get("m", "r1")).toEqual({
            PartitionKey: "m",
            RowKey: "r1",
            value: "kept",
            merged: "added",
          });
        }),
        { timeout: 600_000 },
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
        { timeout: 600_000 },
      );
    });

    describe("CreateTable + QueryTables + DeleteTable", () => {
      test(
        "creates, lists, and deletes a table at runtime",
        Effect.gen(function* () {
          const name = "tbruntime1";
          const created = yield* call(`/tables/create?name=${name}`);
          expectOk(created);
          expect(created.result).toEqual({ tableName: name, again: "TableAlreadyExists" });
          expect((yield* tableNamesOob).includes(name)).toBe(true);

          const listed = yield* call("/tables/list");
          expectOk(listed);
          expect((listed.result.names as string[]).includes(name)).toBe(true);

          const deleted = yield* call(`/tables/delete?name=${name}`);
          expectOk(deleted);
          expect(deleted.result).toEqual({ again: "TableNotFound" });
          const remaining = yield* tableNamesOob.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (names) => !names.includes(name),
              times: 10,
            }),
          );
          expect(remaining.includes(name)).toBe(false);
        }),
        { timeout: 600_000 },
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
            queried: ["a"],
            hasMore: true,
          });
        }),
        { timeout: 600_000 },
      );
    });

    describe("TableWrite", () => {
      test(
        "upserts, updates with an ETag, and deletes",
        Effect.gen(function* () {
          const body = yield* call("/write?pk=w&rk=r1&value=written");
          expectOk(body);
          expect(body.result).toEqual({ etagChanged: true, stale: "TableEntityConditionNotMet" });
          const table = yield* oob("write");
          expect(yield* table.get("w", "r1")).toEqual(undefined);
          expect(yield* table.get("w", "r1-kept")).toEqual({
            PartitionKey: "w",
            RowKey: "r1-kept",
            value: "written",
          });
        }),
        { timeout: 600_000 },
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
            inserted: "TableEntityAlreadyExists",
            queried: ["r1"],
            gone: true,
          });
          const table = yield* oob("readWrite");
          expect(yield* table.get("rw", "r1")).toEqual(undefined);
        }),
        { timeout: 600_000 },
      );
    });

    describe("least-privilege grants", () => {
      test.provider(
        "assigns each binding's role on its own table or the account",
        (_stack) =>
          Effect.gen(function* () {
            const outputs = yield* stack;
            expect(outputs.principalId).toMatch(/^[0-9a-f-]{36}$/);
            const { grants } = yield* grantsOf(outputs.principalId!, outputs.hostStorageAccount);
            const id = (value: string) => value.toLowerCase();
            const ids = outputs.tableIds;
            const reader = `${TS}/entities/read,${TS}/read`;
            const add = `${TS}/entities/add/action`;
            const update = `${TS}/entities/update/action`;
            const del = `${TS}/entities/delete`;
            const read = `${TS}/entities/read`;
            const sorted = (...actions: string[]) => [...actions].sort().join(",");
            expect(grants).toEqual(
              [
                `${id(ids.get)} ${reader}`,
                `${id(ids.query)} ${reader}`,
                `${id(ids.insert)} ${add}`,
                `${id(ids.update)} ${sorted(add, update)}`,
                `${id(ids.merge)} ${sorted(add, update)}`,
                `${id(ids.delete)} ${del}`,
                `${id(outputs.accountId)} ${TS}/write`,
                `${id(outputs.accountId)} ${TS}/delete`,
                `${id(outputs.accountId)} ${TS}/read`,
                `${id(ids.read)} ${reader}`,
                `${id(ids.write)} ${sorted(add, update, del)}`,
                `${id(ids.readWrite)} ${sorted(read, add, update, del)}`,
              ].sort(),
            );
          }),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then prove every role and custom role the bindings created is gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId, hostStorageAccount } = yield* stack;
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const { customRoles } = yield* grantsOf(principalId!, hostStorageAccount);
    yield* destroy(Stack);
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const remaining = yield* authorization
      .ListRoleAssignmentForSubscription({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      })
      .pipe(
        Effect.map((page) => page.value.length),
        Effect.repeat({ schedule: Schedule.spaced("5 seconds"), until: (n) => n === 0, times: 12 }),
      );
    expect(remaining).toEqual(0);
    expect(new Set(customRoles).size).toEqual(8);
    for (const roleDefinitionId of new Set(customRoles)) {
      const gone = yield* authorization
        .GetRoleDefinition({ scope: `/subscriptions/${subscriptionId}`, roleDefinitionId })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("RoleDefinitionNotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (status) => status === "gone",
            times: 12,
          }),
        );
      expect({ roleDefinitionId, gone }).toEqual({ roleDefinitionId, gone: "gone" });
    }
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
