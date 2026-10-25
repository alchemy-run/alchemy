import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as datafactory from "@distilled.cloud/azure/datafactory";
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
import * as Stream from "effect/Stream";
import DataFactoryFunction, {
  Factory,
  Quick,
  Runtime,
  Slow,
  Started,
  Stopped,
} from "./fixtures/function.ts";

const tags = ["provider:azure", "provider:azure:datafactory", "live"];

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureDataFactoryBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* DataFactoryFunction;
    const factory = yield* Factory;
    const quick = yield* Quick;
    const slow = yield* Slow;
    const stopped = yield* Stopped;
    const started = yield* Started;
    const runtime = yield* Runtime;
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      resourceGroup: factory.resourceGroup,
      factoryName: factory.factoryName,
      factoryId: factory.factoryId,
      quickName: quick.pipelineName,
      quickId: quick.pipelineId,
      slowName: slow.pipelineName,
      stoppedName: stopped.triggerName,
      stoppedId: stopped.triggerId,
      startedName: started.triggerName,
      startedId: started.triggerId,
      runtimeId: runtime.integrationRuntimeId,
    };
  }),
);

// The factory, pipelines, triggers (scheduled for 2060) and self-hosted
// runtime are free; four short pipeline runs (~$0.01) and a Flex
// Consumption app (~$0.01/run); ~5 min deploy.
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
 * cold start and role propagation, then return the last answer so a real
 * failure shows its Azure error.
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

// --- out-of-band reads and writes (deployer credentials) ---

const factoryRef = Effect.gen(function* () {
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  const { resourceGroup, factoryName } = yield* stack;
  return { subscriptionId, resourceGroupName: resourceGroup, factoryName };
});

/** Start a run of `pipelineName` with the deployer's credentials. */
const seedRun = (pipelineName: string) =>
  Effect.gen(function* () {
    const ref = yield* factoryRef;
    const { runId } = yield* datafactory.CreatePipelineRun({ ...ref, pipelineName });
    return runId;
  }).pipe(Effect.provide(azure));

const observeRun = (runId: string) =>
  Effect.gen(function* () {
    const ref = yield* factoryRef;
    return yield* datafactory.GetPipelineRun({ ...ref, runId });
  }).pipe(Effect.provide(azure));

/** Poll a run until its status is `status`. */
const untilRunStatus = (runId: string, status: string) =>
  observeRun(runId).pipe(
    Effect.map((run) => run.status),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (observed) => observed === status,
      times: 24,
    }),
  );

/** Start or stop a trigger with the deployer's credentials. */
const setTrigger = (triggerName: string, state: "Started" | "Stopped") =>
  Effect.gen(function* () {
    const ref = yield* factoryRef;
    yield* state === "Started"
      ? datafactory.StartTrigger({ ...ref, triggerName })
      : datafactory.StopTrigger({ ...ref, triggerName });
  }).pipe(Effect.provide(azure));

const observeTriggerState = (triggerName: string) =>
  Effect.gen(function* () {
    const ref = yield* factoryRef;
    const trigger = yield* datafactory.GetTrigger({ ...ref, triggerName });
    return trigger.properties.runtimeState;
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

/** Every role on the Function's identity as `<actions> <scope>`. */
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

/** A run ID no trigger ever produced. */
const UNKNOWN_RUN = "00000000-0000-0000-0000-000000000000";

describe("Azure Data Factory bindings on an Azure Function", { tags }, () => {
  describe("DataFactory.RunPipeline", () => {
    test(
      "starts a run of the bound pipeline",
      Effect.gen(function* () {
        const { quickName } = yield* stack;
        const body = yield* call("/run-pipeline");
        expectOk(body);
        const runId = body.result.runId as string;
        expect(runId).toMatch(/^[0-9a-f-]{36}$/);
        const run = yield* observeRun(runId);
        expect(run.pipelineName).toEqual(quickName);
        expect(yield* untilRunStatus(runId, "Succeeded")).toEqual("Succeeded");
      }),
      { timeout: 600_000 },
    );
  });

  describe("DataFactory.GetPipelineRun", () => {
    test(
      "reads a run the deployer started",
      Effect.gen(function* () {
        const { quickName } = yield* stack;
        const runId = yield* seedRun(quickName);
        const body = yield* call(`/get-pipeline-run?run=${runId}`);
        expectOk(body);
        expect(body.result).toEqual({ runId, pipelineName: quickName });
      }),
      { timeout: 600_000 },
    );
  });

  describe("DataFactory.CancelPipelineRun", () => {
    test(
      "cancels a waiting run the deployer started",
      Effect.gen(function* () {
        const { slowName } = yield* stack;
        const runId = yield* seedRun(slowName);
        const body = yield* call(`/cancel-pipeline-run?run=${runId}`);
        expectOk(body);
        expect(yield* untilRunStatus(runId, "Cancelled")).toEqual("Cancelled");
      }),
      { timeout: 600_000 },
    );
  });

  describe("DataFactory.QueryPipelineRuns", () => {
    test(
      "finds a run the deployer started",
      Effect.gen(function* () {
        const { quickName } = yield* stack;
        const runId = yield* seedRun(quickName);
        const route = `/query-pipeline-runs?pipeline=${quickName}`;
        expectOk(yield* call(route));
        // The run index trails a new run by a few seconds.
        const found = yield* call(route).pipe(
          Effect.map((body) => (body.result ?? []) as string[]),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (runIds) => runIds.includes(runId),
            times: 12,
          }),
        );
        expect(found).toContain(runId);
      }),
      { timeout: 600_000 },
    );
  });

  describe("DataFactory.StartTrigger", () => {
    test(
      "starts the bound trigger",
      Effect.gen(function* () {
        const { stoppedName } = yield* stack;
        // Deployed stopped; stop it again so a retried test starts from there.
        yield* setTrigger(stoppedName, "Stopped");
        expect(yield* observeTriggerState(stoppedName)).toEqual("Stopped");
        const body = yield* call("/start-trigger");
        expectOk(body);
        expect(yield* observeTriggerState(stoppedName)).toEqual("Started");
      }),
      { timeout: 600_000 },
    );
  });

  describe("DataFactory.StopTrigger", () => {
    test(
      "stops the bound trigger",
      Effect.gen(function* () {
        const { startedName } = yield* stack;
        // Deployed started; start it again so a retried test starts from there.
        yield* setTrigger(startedName, "Started");
        expect(yield* observeTriggerState(startedName)).toEqual("Started");
        const body = yield* call("/stop-trigger");
        expectOk(body);
        expect(yield* observeTriggerState(startedName)).toEqual("Stopped");
      }),
      { timeout: 600_000 },
    );
  });

  // The trigger is scheduled for 2060, so it has no runs: the binding
  // reaches the action (no `AuthorizationFailed`) and Azure answers a typed
  // rejection (only tumbling window trigger runs can be rerun).
  describe("DataFactory.CancelTriggerRun", () => {
    test(
      "reaches the bound trigger's runs",
      Effect.gen(function* () {
        const body = yield* call(`/cancel-trigger-run?run=${UNKNOWN_RUN}`);
        expectOk(body);
        expect(body.result).toEqual({ rejected: "TriggerRunNotFound" });
      }),
      { timeout: 600_000 },
    );
  });

  describe("DataFactory.RerunTriggerRun", () => {
    test(
      "reaches the bound trigger's runs",
      Effect.gen(function* () {
        const body = yield* call(`/rerun-trigger-run?run=${UNKNOWN_RUN}`);
        expectOk(body);
        expect(body.result).toEqual({ rejected: "TriggerRerunNotSupported" });
      }),
      { timeout: 600_000 },
    );
  });

  // Start and stop apply only to managed (Azure-SSIS) runtimes, which cost
  // ~$1/hour and take ~20 minutes to start. The self-hosted runtime here
  // proves the grant and the request: Azure answers its typed rejection.
  describe("DataFactory.StartIntegrationRuntime", () => {
    test(
      "reaches the bound integration runtime",
      Effect.gen(function* () {
        const body = yield* call("/start-integration-runtime");
        expectOk(body);
        expect(body.result).toEqual({ rejected: "IntegrationRuntimeNotManaged" });
      }),
      { timeout: 600_000 },
    );
  });

  describe("DataFactory.StopIntegrationRuntime", () => {
    test(
      "reaches the bound integration runtime",
      Effect.gen(function* () {
        const body = yield* call("/stop-integration-runtime");
        expectOk(body);
        expect(body.result).toEqual({ rejected: "IntegrationRuntimeNotManaged" });
      }),
      { timeout: 600_000 },
    );
  });

  describe("AzureBindings.Bind least privilege", () => {
    test(
      "assigns exactly each binding's action on its resource only",
      Effect.gen(function* () {
        const outputs = yield* stack;
        expect(outputs.principalId).toMatch(/^[0-9a-f-]{36}$/);
        // Role-assignment lists trail new assignments by a few minutes.
        const grants = yield* grantsOf(outputs.principalId!, outputs.hostStorageAccount).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (listed) => listed.length >= 10,
            times: 18,
          }),
          Effect.provide(azure),
        );
        const df = "Microsoft.DataFactory/factories";
        const factory = outputs.factoryId.toLowerCase();
        const started = outputs.startedId.toLowerCase();
        const runtime = outputs.runtimeId.toLowerCase();
        expect(grants).toEqual(
          [
            `${df}/pipelines/createrun/action ${outputs.quickId.toLowerCase()}`,
            `${df}/pipelineruns/read ${factory}`,
            `${df}/pipelineruns/cancel/action ${factory}`,
            `${df}/querypipelineruns/read ${factory}`,
            `${df}/triggers/start/action ${outputs.stoppedId.toLowerCase()}`,
            `${df}/triggers/stop/action ${started}`,
            `${df}/triggers/triggerruns/cancel/action ${started}`,
            `${df}/triggers/triggerruns/rerun/action ${started}`,
            `${df}/integrationruntimes/start/action ${runtime}`,
            `${df}/integrationruntimes/stop/action ${runtime}`,
          ].sort(),
        );
      }),
      { timeout: 300_000 },
    );
  });
});

// Destroy, then prove the factory and every role assigned to the
// Function's identity are gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId, hostStorageAccount } = yield* stack;
    const ref = yield* factoryRef;
    yield* destroy(Stack);
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const remaining = yield* assignmentsOf(principalId!, hostStorageAccount).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 24,
      }),
    );
    expect(remaining.map((a) => a.properties?.scope)).toEqual([]);
    const factory = yield* datafactory.GetFactory(ref).pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
        Effect.succeed("gone" as const),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (status) => status === "gone",
        times: 12,
      }),
    );
    expect(factory).toEqual("gone");
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
