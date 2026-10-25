import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as nosql from "@distilled.cloud/azure/cosmos-nosql";
import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Output from "alchemy/Output";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import CosmosBindingsFunction, { Account, Database, Items } from "./fixtures/function.ts";
import { waitGone } from "./helpers.ts";

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
  "AzureCosmosBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* CosmosBindingsFunction;
    const account = yield* Account;
    const database = yield* Database;
    const items = yield* Items;
    // The deployer seeds and reads documents out of band.
    const deployer = yield* deployerObjectId.pipe(Effect.orDie);
    yield* Azure.CosmosDB.SqlRoleAssignment("CosmosBindingsDeployer", {
      account: account.accountName,
      roleDefinitionId: Azure.CosmosDB.SqlBuiltInRole.DataContributor,
      principalId: deployer,
      scope: Output.interpolate`/dbs/${database.databaseName}/colls/${items.containerName}`,
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      resourceGroup: account.resourceGroup,
      accountName: account.accountName,
      databaseId: database.databaseName,
      collectionId: items.containerName,
    };
  }),
);

// Serverless Cosmos DB account in centralus (~$0 idle) + a Flex Consumption
// app; ~5 min deploy, ~4 min data-role deletes, ~8-15 min account delete.
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
 * cold start and Cosmos DB data-role propagation (about 6 minutes), then
 * return the last answer so a real failure shows its Cosmos DB error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** The deployer's data role can trail the deploy by a few minutes. */
const whileDenied = {
  while: (e: { readonly _tag: string }) => e._tag === "CosmosRbacPermissionDenied",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

const container = Effect.map(stack, ({ accountName, databaseId, collectionId }) => ({
  accountName,
  databaseId,
  collectionId,
}));

/** Write `{ id, tenant, value }` out of band. */
const seed = (id: string, tenant: string, value: string) =>
  Effect.gen(function* () {
    const where = yield* container;
    yield* nosql
      .UpsertDocument({ ...where, document: { id, tenant, value }, partitionKey: [tenant] })
      .pipe(Effect.retry(whileDenied));
  });

/** The document's `value` out of band, or `undefined` when it does not exist. */
const valueAt = (id: string, tenant: string) =>
  Effect.gen(function* () {
    const where = yield* container;
    return yield* nosql.GetDocument({ ...where, documentId: id, partitionKey: [tenant] }).pipe(
      Effect.map((res) => (res.document as { value?: unknown } | undefined)?.value),
      Effect.catchTag("CosmosNotFound", () => Effect.succeed(undefined)),
      Effect.retry(whileDenied),
    );
  });

/** Delete a document out of band; a missing one is fine. */
const remove = (id: string, tenant: string) =>
  Effect.gen(function* () {
    const where = yield* container;
    yield* nosql.DeleteDocument({ ...where, documentId: id, partitionKey: [tenant] }).pipe(
      Effect.catchTag("CosmosNotFound", () => Effect.void),
      Effect.retry(whileDenied),
    );
  });

const live = { timeout: 600_000 };

describe(
  "Cosmos DB for NoSQL bindings on an Azure Function",
  {
    tags: ["provider:azure", "live"],
  },
  () => {
    describe("CosmosDB.CreateDocument", () => {
      test(
        "creates a document",
        Effect.gen(function* () {
          yield* remove("create-1", "create");
          const body = yield* call("/create?id=create-1&tenant=create&value=new");
          expectOk(body);
          expect(body.result.id).toEqual("create-1");
          expect(body.result.etag).toMatch(/^"[0-9a-f-]+"$/);
          expect(yield* valueAt("create-1", "create")).toEqual("new");
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("CosmosDB.GetDocument", () => {
      test(
        "reads a document by id and partition key",
        Effect.gen(function* () {
          yield* seed("get-1", "get", "seeded");
          const body = yield* call("/get?id=get-1&tenant=get");
          expectOk(body);
          expect(body.result.value).toEqual("seeded");
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("CosmosDB.ListDocuments", () => {
      test(
        "lists the documents of a partition",
        Effect.gen(function* () {
          yield* seed("list-1", "list", "a");
          yield* seed("list-2", "list", "b");
          yield* seed("other-1", "other", "c");
          const body = yield* call("/list?tenant=list");
          expectOk(body);
          expect(body.result).toEqual({ ids: ["list-1", "list-2"], count: 2 });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("CosmosDB.QueryDocuments", () => {
      test(
        "runs a parameterized query",
        Effect.gen(function* () {
          yield* seed("query-1", "query", "a");
          yield* seed("query-2", "query", "b");
          const body = yield* call("/query?tenant=query");
          expectOk(body);
          expect(body.result.ids).toEqual(["query-1", "query-2"]);
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("CosmosDB.UpsertDocument", () => {
      test(
        "creates, then replaces a document",
        Effect.gen(function* () {
          yield* remove("upsert-1", "upsert");
          expectOk(yield* call("/upsert?id=upsert-1&tenant=upsert&value=first"));
          expect(yield* valueAt("upsert-1", "upsert")).toEqual("first");
          const body = yield* call("/upsert?id=upsert-1&tenant=upsert&value=second");
          expectOk(body);
          expect(body.result.value).toEqual("second");
          expect(yield* valueAt("upsert-1", "upsert")).toEqual("second");
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("CosmosDB.ReplaceDocument", () => {
      test(
        "replaces a whole document",
        Effect.gen(function* () {
          yield* seed("replace-1", "replace", "before");
          const body = yield* call("/replace?id=replace-1&tenant=replace&value=after");
          expectOk(body);
          expect(body.result.value).toEqual("after");
          expect(yield* valueAt("replace-1", "replace")).toEqual("after");
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("CosmosDB.PatchDocument", () => {
      test(
        "sets one field of a document",
        Effect.gen(function* () {
          yield* seed("patch-1", "patch", "before");
          const body = yield* call("/patch?id=patch-1&tenant=patch&value=patched");
          expectOk(body);
          expect(body.result.value).toEqual("patched");
          expect(yield* valueAt("patch-1", "patch")).toEqual("patched");
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("CosmosDB.DeleteDocument", () => {
      test(
        "deletes a document",
        Effect.gen(function* () {
          yield* seed("delete-1", "delete", "doomed");
          const body = yield* call("/delete?id=delete-1&tenant=delete");
          expectOk(body);
          expect(yield* valueAt("delete-1", "delete")).toBeUndefined();
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("CosmosDB.SqlContainerRead", () => {
      test(
        "gets, lists, and queries documents",
        Effect.gen(function* () {
          yield* seed("read-1", "read", "one");
          yield* seed("read-2", "read", "two");
          const body = yield* call("/read?id=read-1&tenant=read");
          expectOk(body);
          expect(body.result).toEqual({
            value: "one",
            listed: ["read-1", "read-2"],
            queried: ["read-1", "read-2"],
          });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("CosmosDB.SqlContainerWrite", () => {
      test(
        "creates, upserts, replaces, patches, and deletes documents",
        Effect.gen(function* () {
          yield* remove("write-1", "write");
          yield* remove("write-1-gone", "write");
          const body = yield* call("/write?id=write-1&tenant=write&value=final");
          expectOk(body);
          expect(body.result.value).toEqual("final");
          expect(yield* valueAt("write-1", "write")).toEqual("final");
          expect(yield* valueAt("write-1-gone", "write")).toBeUndefined();
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("CosmosDB.SqlContainerReadWrite", () => {
      test(
        "upserts, reads, queries, patches, and deletes a document",
        Effect.gen(function* () {
          const body = yield* call("/read-write?id=rw-1&tenant=rw&value=v");
          expectOk(body);
          expect(body.result).toEqual({
            value: "v",
            queried: ["rw-1"],
            patched: "v-patched",
            missing: true,
          });
          expect(yield* valueAt("rw-1", "rw")).toBeUndefined();
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("least privilege", () => {
      test(
        "assigns one data role per binding, scoped to the container, with exactly its actions",
        Effect.gen(function* () {
          const out = yield* stack;
          expect(out.principalId).toMatch(/^[0-9a-f-]{36}$/);
          const { subscriptionId } = yield* Azure.AzureEnvironment.current;
          const where = {
            subscriptionId,
            resourceGroupName: out.resourceGroup,
            accountName: out.accountName,
          };
          const page = yield* cosmos.ListSqlResourceSqlRoleAssignments(where);
          const mine = (page.value ?? []).filter(
            (a) => a.properties?.principalId === out.principalId,
          );
          const scope = `/dbs/${out.databaseId}/colls/${out.collectionId}`.toLowerCase();
          const roles: string[] = [];
          for (const assignment of mine) {
            expect(assignment.properties?.scope?.toLowerCase().endsWith(scope)).toBe(true);
            const roleDefinitionId =
              assignment.properties?.roleDefinitionId?.split("/").pop() ?? "";
            const role = yield* cosmos.GetSqlResourceSqlRoleDefinition({
              ...where,
              roleDefinitionId,
            });
            const actions = (role.properties?.permissions ?? [])
              .flatMap((p) => p.dataActions ?? [])
              .map((a) => a.replace("Microsoft.DocumentDB/databaseAccounts/", ""))
              .sort();
            roles.push(actions.join(" "));
          }
          const items = "sqlDatabases/containers/items";
          const query = "sqlDatabases/containers/executeQuery";
          const feed = "sqlDatabases/containers/readChangeFeed";
          const meta = "readMetadata";
          const role = (...actions: string[]) => [...actions].sort().join(" ");
          expect(roles.sort()).toEqual(
            [
              role(meta, `${items}/create`),
              role(meta, `${items}/delete`),
              role(meta, `${items}/read`),
              role(meta, feed),
              // ReplaceDocument and PatchDocument share one assignment.
              role(meta, `${items}/replace`),
              role(meta, query, feed),
              role(meta, `${items}/upsert`),
              // SqlContainerRead: the built-in Data Reader.
              role(meta, `${items}/read`, query, feed),
              role(
                meta,
                `${items}/create`,
                `${items}/upsert`,
                `${items}/replace`,
                `${items}/delete`,
              ),
              role(
                meta,
                `${items}/read`,
                `${items}/create`,
                `${items}/upsert`,
                `${items}/replace`,
                `${items}/delete`,
                query,
                feed,
              ),
            ].sort(),
          );
        }).pipe(Effect.provide(azure)),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then prove the account (and every data role on it) is gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    // `undefined` when the deploy failed; destroy still removes what it created.
    const out = yield* stack;
    yield* destroy(Stack);
    if (out !== undefined) {
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      expect(
        yield* waitGone(
          cosmos.GetDatabaseAccount({
            subscriptionId,
            resourceGroupName: out.resourceGroup,
            accountName: out.accountName,
          }),
        ),
      ).toEqual("gone");
    }
  }).pipe(Effect.provide(azure)),
  // Data-role deletes (~4 min) + the account delete (up to 15 min).
  { timeout: 1_800_000 },
);
