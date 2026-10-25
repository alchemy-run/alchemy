import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as insights from "@distilled.cloud/azure/monitor-insights";
import * as query from "@distilled.cloud/azure/monitor-operational-insights";
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
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { runExpensive } from "../gates.ts";
import MonitorFunction, {
  Events,
  Logs,
  Metered,
  RuleTarget,
  TABLE_NAME,
} from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureMonitorBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* MonitorFunction;
    const workspace = yield* Logs;
    const table = yield* Events;
    const rule = yield* RuleTarget;
    const account = yield* Metered;
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      customerId: workspace.customerId,
      workspaceId: workspace.workspaceId,
      tableName: table.tableName,
      dcrId: rule.dataCollectionRuleId,
      accountId: account.storageAccountId,
      accountLocation: account.location,
    };
  }),
);

// ~$0.02/run (Flex Consumption, a PerGB2018 workspace with a few rows, a
// storage account, a data collection rule); ~2 min deploy, ~6 min for the
// first ingested row to become queryable.
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

/** Run a query as the deployer against the stack's workspace. */
const deployerQuery = (text: string) =>
  Effect.gen(function* () {
    const { customerId } = yield* stack;
    return yield* query.ExecuteQuery({ workspaceId: customerId, query: text, timespan: "P1D" });
  }).pipe(Effect.provide(azure));

/** Role assignments of the Function's identity, without its own host-storage grants. */
const assignmentsOf = (principalId: string, hostStorageAccount: string | undefined) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    // Every page: a filtered list can answer an empty first page with a `nextLink`.
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    const host = `/storageaccounts/${(hostStorageAccount ?? "").toLowerCase()}`;
    return Array.from(assignments).filter(
      (a) => !(a.properties?.scope?.toLowerCase() ?? "").endsWith(host),
    );
  });

/** Every role on the Function's identity as `<actions + data actions> <scope>`. */
const grantsOf = (principalId: string, hostStorageAccount: string | undefined) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const grants: string[] = [];
    for (const assignment of yield* assignmentsOf(principalId, hostStorageAccount)) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      const actions = (definition.properties?.permissions ?? [])
        .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
        .sort()
        .join("+");
      grants.push(`${actions} ${scope}`);
    }
    return grants.sort();
  });

describe(
  "Azure Monitor bindings on an Azure Function",
  { tags: ["provider:azure", "live"] },
  () => {
    describe("LogAnalytics.ExecuteQuery", () => {
      test(
        "runs a POST query in the bound workspace",
        Effect.gen(function* () {
          const body = yield* call("/execute-query");
          expectOk(body);
          expect(body.result).toEqual({ answer: 42 });
          const observed = yield* deployerQuery("print answer = 42");
          expect(observed.tables[0]?.rows).toEqual([[42]]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("LogAnalytics.GetQuery", () => {
      test(
        "runs a GET query in the bound workspace",
        Effect.gen(function* () {
          const body = yield* call("/get-query");
          expectOk(body);
          expect(body.result).toEqual({ answer: 43 });
        }),
        { timeout: 300_000 },
      );
    });

    describe("LogAnalytics.QueryBatch", () => {
      test(
        "answers every query of the batch by id",
        Effect.gen(function* () {
          const body = yield* call("/query-batch");
          expectOk(body);
          expect(body.result).toEqual([
            { id: "one", status: 200, n: 1 },
            { id: "two", status: 200, n: 2 },
          ]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("LogAnalytics.GetMetadata", () => {
      test(
        "lists the workspace's custom table",
        Effect.gen(function* () {
          const { tableName } = yield* stack;
          const body = yield* call("/get-metadata");
          expectOk(body);
          expect(tableName).toEqual(TABLE_NAME);
          expect(body.result.tables).toContain(TABLE_NAME);
        }),
        { timeout: 300_000 },
      );
    });

    describe("LogAnalytics.PostMetadata", () => {
      test(
        "lists the workspace's custom table",
        Effect.gen(function* () {
          const body = yield* call("/post-metadata");
          expectOk(body);
          expect(body.result.tables).toContain(TABLE_NAME);
        }),
        { timeout: 300_000 },
      );
    });

    describe("LogAnalytics.ExecuteQueryWithResourceId", () => {
      test(
        "runs a POST resource-context query for the bound resource",
        Effect.gen(function* () {
          const body = yield* call("/execute-resource-query");
          expectOk(body);
          expect(body.result).toEqual({ answer: 44 });
        }),
        { timeout: 300_000 },
      );
    });

    describe("LogAnalytics.GetQueryWithResourceId", () => {
      test(
        "runs a GET resource-context query for the bound resource",
        Effect.gen(function* () {
          const body = yield* call("/get-resource-query");
          expectOk(body);
          expect(body.result).toEqual({ answer: 45 });
        }),
        { timeout: 300_000 },
      );
    });

    describe("Monitor.UploadLogs", () => {
      test(
        "sends a row through the data collection rule",
        Effect.gen(function* () {
          // Payload data, not a resource name: tells this run's row apart.
          const run = yield* Effect.sync(() => crypto.randomUUID());
          const body = yield* call(`/upload-logs?run=${run}`);
          expectOk(body);
          expect(body.result).toEqual({ sent: run });
        }),
        { timeout: 300_000 },
      );

      // ~$0.01/run, 6-15 min: the first rows of a new table and rule take that
      // long to become queryable (6 min in one live run; 10 min was not enough
      // in the next).
      test.skipIf(!runExpensive)(
        "the row lands in the rule's table",
        Effect.gen(function* () {
          const run = yield* Effect.sync(() => crypto.randomUUID());
          const body = yield* call(`/upload-logs?run=${run}`);
          expectOk(body);
          const counted = yield* deployerQuery(
            `${TABLE_NAME} | where RunId == '${run}' | count`,
          ).pipe(
            Effect.map((result) => result.tables[0]?.rows[0]?.[0]),
            Effect.repeat({
              schedule: Schedule.spaced("15 seconds"),
              until: (count) => count === 1,
              times: 64,
            }),
          );
          expect(counted).toEqual(1);
        }),
        { timeout: 1_200_000 },
      );
    });

    describe("Monitor.GetMetricsBatch", () => {
      test(
        "reads the bound account's metrics like the deployer does",
        Effect.gen(function* () {
          const { accountId, accountLocation } = yield* stack;
          const body = yield* call("/metrics");
          expectOk(body);
          expect(body.result).toEqual([
            { resourceid: accountId.toLowerCase(), metrics: ["Ingress", "Transactions"] },
          ]);
          const observed = yield* insights
            .Batch({
              endpoint: `https://${accountLocation}.metrics.monitor.azure.com`,
              subscriptionId: accountId.split("/")[2]!,
              metricnamespace: "Microsoft.Storage/storageAccounts",
              metricnames: ["Transactions,Ingress"],
              aggregation: "total",
              interval: "PT1H",
              resourceids: [accountId],
            })
            .pipe(Effect.provide(azure));
          expect(observed.values?.map((value) => value.resourceid?.toLowerCase())).toEqual([
            accountId.toLowerCase(),
          ]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("AzureBindings.Bind least privilege", () => {
      test(
        "assigns exactly each binding's permissions on the narrowest scope the API accepts",
        Effect.gen(function* () {
          const outputs = yield* stack;
          expect(outputs.principalId).toMatch(/^[0-9a-f-]{36}$/);
          // Role-assignment lists trail new assignments by a few minutes.
          const grants = yield* grantsOf(outputs.principalId!, outputs.hostStorageAccount).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (listed) => listed.length >= 4,
              times: 18,
            }),
            Effect.provide(azure),
          );
          const workspace = outputs.workspaceId.toLowerCase();
          const dcr = outputs.dcrId.toLowerCase();
          const account = outputs.accountId.toLowerCase();
          const subscription = `/subscriptions/${outputs.accountId.split("/")[2]!.toLowerCase()}`;
          expect(grants).toEqual(
            [
              `Microsoft.OperationalInsights/workspaces/query/read+Microsoft.OperationalInsights/workspaces/read+Microsoft.OperationalInsights/workspaces/tables/data/read ${workspace}`,
              `Microsoft.Insights/Telemetry/Write ${dcr}`,
              `Microsoft.Insights/logs/*/read ${account}`,
              `*/read+Microsoft.OperationalInsights/workspaces/search/action+Microsoft.Support/* ${subscription}`,
            ].sort(),
          );
        }),
        { timeout: 300_000 },
      );
    });
  },
);

// Destroy, then prove every role assigned to the Function's identity is gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId, hostStorageAccount } = yield* stack;
    yield* destroy(Stack);
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const remaining = yield* assignmentsOf(principalId!, hostStorageAccount).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 12,
      }),
    );
    expect(remaining.map((a) => a.properties?.scope)).toEqual([]);
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
