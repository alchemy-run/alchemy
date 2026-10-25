import * as Azure from "@alchemy.run/azure";
import { Credentials, type Config } from "@distilled.cloud/azure";
import * as syms from "@distilled.cloud/azure/synapse-data";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import SynLakeFunction, {
  DATABASE,
  DDL_DATABASE,
  Workspace,
} from "./fixtures/lake-database-function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

describe("Synapse lake database request encoding", { tags: ["provider:azure"] }, () => {
  /** Capture the one request an operation sends, with a token per audience. */
  const captured = <A, E>(
    operation: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
    body: string,
  ) =>
    Effect.gen(function* () {
      const calls: { method: string; url: string; auth?: string; body?: string }[] = [];
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request, url) =>
          Effect.sync(() => {
            calls.push({
              method: request.method,
              url: url.href,
              auth: request.headers.authorization,
              body:
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : undefined,
            });
            return HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }));
          }),
        ),
      );
      const credentials = Layer.succeed(
        Credentials,
        Effect.succeed<Config>({
          bearerToken: Redacted.make("arm-token"),
          subscriptionId: "00000000-0000-0000-0000-000000000001",
          apiBaseUrl: "https://management.azure.com",
          tokenFor: (scope: string) => Effect.succeed(Redacted.make(`aad:${scope}`)),
        }),
      );
      const result = yield* operation.pipe(
        Effect.provide(credentials),
        Effect.provide(http),
        Effect.result,
      );
      return { calls, result };
    });

  const endpoint = "https://lake.dev.azuresynapse.net";

  test(
    "ListPartitionInfosForSchemaAndTable addresses the table's partitions with a Synapse token",
    Effect.gen(function* () {
      const { calls } = yield* captured(
        syms.ListPartitionInfosForSchemaAndTable({
          endpoint,
          databaseName: "sales",
          schemaName: "dbo",
          tableName: "orders",
          maxPageSize: 10,
        }),
        '{"items":[]}',
      );
      expect(calls.map(({ method, url, auth }) => ({ method, url, auth }))).toEqual([
        {
          method: "GET",
          url: `${endpoint}/databases/sales/schemas/dbo/tables/orders/partitionInfos?maxPageSize=10&api-version=2021-04-01`,
          auth: "Bearer aad:https://dev.azuresynapse.net/.default",
        },
      ]);
    }),
  );

  test(
    "PutArtifactInSchema puts the entity under its schema",
    Effect.gen(function* () {
      const { calls } = yield* captured(
        syms.PutArtifactInSchema({
          endpoint,
          databaseName: "sales",
          schemaName: "dbo",
          artifactType: "TABLE",
          artifactName: "orders",
          name: "orders",
          type: "TABLE",
          properties: { TableType: "EXTERNAL" },
        }),
        '{"DDLType":"CREATE","EntityName":"orders","EntityType":"TABLE","PublishStatus":"PUBLISHED","OriginObjectId":null,"ObjectId":"o","ObjectVersion":1}',
      );
      expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([
        {
          method: "PUT",
          url: `${endpoint}/databases/sales/schemas/dbo/TABLEs/orders?api-version=2021-04-01`,
        },
      ]);
      expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
        name: "orders",
        type: "TABLE",
        properties: { TableType: "EXTERNAL" },
      });
    }),
  );

  test(
    "DDL responses decode from SyMS's PascalCase",
    Effect.gen(function* () {
      const { result } = yield* captured(
        syms.PutDatabase({
          endpoint,
          databaseName: "sales",
          name: "sales",
          type: "DATABASE",
          properties: {},
        }),
        '{"DDLType":"CREATE","EntityName":"sales","EntityType":"DATABASE","PublishStatus":"PUBLISHED","OriginObjectId":null,"ObjectId":"o-1","ObjectVersion":1}',
      );
      expect(result._tag).toEqual("Success");
      if (result._tag === "Success") {
        expect(result.success).toMatchObject({
          ddlType: "CREATE",
          entityName: "sales",
          entityType: "DATABASE",
          objectId: "o-1",
          objectVersion: 1,
        });
      }
    }),
  );
});

const Stack = Alchemy.Stack(
  "AzureSynapseLakeBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* SynLakeFunction;
    const workspace = yield* Workspace;
    return {
      url: fn.url,
      principalId: fn.principalId,
      workspaceName: workspace.workspaceName,
      dev: workspace.connectivityEndpoints.dev,
    };
  }),
);

// A workspace is free while idle (serverless SQL only, no pools); the lake
// account and Flex Consumption cost cents. ~8-12 min deploy (workspace
// provisioning).
const stack = beforeAll(deploy(Stack), { timeout: 1_500_000 });

/** Deployer credentials and environment for out-of-band checks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and Synapse role propagation (2-5 min), then return the last
 * answer so a real failure shows its Azure error.
 */
const call = (route: string, times = 60) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.execute(HttpClientRequest.get(`${url}${route}`)).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.flatMap((json) => (json?.ok ? Effect.succeed(json) : Effect.fail(json))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times }),
      Effect.catch((json) => Effect.succeed(json as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** Run a `synapse-data` call as the deployer (the workspace's creator, a Synapse Administrator). */
const asDeployer = <A, E>(f: (endpoint: string) => Effect.Effect<A, E, any>) =>
  Effect.gen(function* () {
    const { dev } = yield* stack;
    return yield* f(dev ?? "") as Effect.Effect<A, E>;
  }).pipe(Effect.provide(azure));

/** A lake database as the deployer sees it: its name, or `"gone"`. */
const observedDatabase = (databaseName: string) =>
  asDeployer((endpoint) =>
    syms.GetDatabase({ endpoint, databaseName }).pipe(
      Effect.map((db) => db.name),
      Effect.catchTag("ResourceNotFound", () => Effect.succeed("gone")),
    ),
  );

describe(
  "Synapse lake database bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:synapse", "live"] },
  () => {
    describe("Synapse.PutDatabase", () => {
      test(
        "creates the lake database",
        Effect.gen(function* () {
          const body = yield* call("/db/put");
          expectOk(body);
          expect(body.result).toEqual({ entityName: DATABASE, entityType: "DATABASE" });
          expect(yield* observedDatabase(DATABASE)).toEqual(DATABASE);
        }),
        { timeout: 600_000 },
      );
    });

    describe("Synapse.GetDatabase", () => {
      test(
        "reads the lake database",
        Effect.gen(function* () {
          const body = yield* call("/db/get");
          expectOk(body);
          expect(body.result).toEqual({ name: DATABASE, type: "DATABASE" });
        }),
        { timeout: 600_000 },
      );
    });

    describe("Synapse.ListDatabases", () => {
      test(
        "lists the lake database",
        Effect.gen(function* () {
          const body = yield* call("/db/list");
          expectOk(body);
          expect(body.result).toContain(DATABASE);
        }),
        { timeout: 300_000 },
      );
    });

    describe("Synapse.ListArtifacts", () => {
      test(
        "lists no tables in a new database, and GetArtifactFromDB types a missing one",
        Effect.gen(function* () {
          const body = yield* call("/db/tables");
          expectOk(body);
          expect(body.result).toEqual({ tables: [], missing: "ResourceNotFound" });
        }),
        { timeout: 300_000 },
      );
    });

    describe("Synapse.ExecuteChange", () => {
      test(
        "creates and drops a database through DDL",
        Effect.gen(function* () {
          const created = yield* call("/ddl/create", 12);
          expectOk(created);
          expect(created.result).toEqual([`CREATE ${DDL_DATABASE}`]);
          expect(yield* observedDatabase(DDL_DATABASE)).toEqual(DDL_DATABASE);
          const dropped = yield* call("/ddl/drop", 12);
          expectOk(dropped);
          // SyMS answers a DROP with an empty list.
          expect(dropped.result).toEqual(0);
          const status = yield* observedDatabase(DDL_DATABASE).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (s) => s === "gone",
              times: 12,
            }),
          );
          expect(status).toEqual("gone");
        }),
        { timeout: 300_000 },
      );
    });

    describe("Synapse.DeleteDatabase", () => {
      test(
        "deletes the lake database",
        Effect.gen(function* () {
          expectOk(yield* call("/db/delete"));
          const status = yield* observedDatabase(DATABASE).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (s) => s === "gone",
              times: 12,
            }),
          );
          expect(status).toEqual("gone");
        }),
        { timeout: 300_000 },
      );
    });

    describe("AzureBindings.Bind least privilege", () => {
      test(
        "assigns Synapse Artifact User and Artifact Publisher on the workspace only",
        Effect.gen(function* () {
          const { principalId, workspaceName } = yield* stack;
          const page = yield* asDeployer((endpoint) =>
            syms.ListRoleAssignments({ endpoint, principalId: principalId ?? "" }),
          );
          expect((page.value ?? []).map((a) => `${a.roleDefinitionId} ${a.scope}`).sort()).toEqual(
            [
              `${Azure.Synapse.SynapseRole.ArtifactPublisher} workspaces/${workspaceName}`,
              `${Azure.Synapse.SynapseRole.ArtifactUser} workspaces/${workspaceName}`,
            ].sort(),
          );
        }),
        { timeout: 120_000 },
      );
    });
  },
);

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 1_500_000 });
