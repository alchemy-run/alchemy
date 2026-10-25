import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as logic from "@distilled.cloud/azure/logic";
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
import LogicFunction, { Resettable, Sleeper, Ticker, TRIGGER } from "./fixtures/function.ts";
import { tags } from "./util.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureLogicBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* LogicFunction;
    const ticker = yield* Ticker;
    const sleeper = yield* Sleeper;
    const resettable = yield* Resettable;
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      ticker: ticker.workflowId,
      sleeper: sleeper.workflowId,
      resettable: resettable.workflowId,
      resourceGroup: ticker.resourceGroup,
    };
  }),
);

// Three Consumption workflows billed per action run (well under $0.01) and
// a Flex Consumption app (~$0.01/run); ~5 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** Deployer credentials and environment for out-of-band checks and hooks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: unknown; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation, then return the last answer so a real
 * failure shows its ARM error.
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

/** `subscriptionId`, `resourceGroupName` and `workflowName` of a workflow ID. */
const workflowOf = (workflowId: string) => {
  const parts = workflowId.split("/");
  return {
    subscriptionId: parts[2]!,
    resourceGroupName: parts[4]!,
    workflowName: parts[8]!,
  };
};

/** Runs of a workflow (deployer credentials). */
const runsOf = (workflowId: string) =>
  logic.ListWorkflowRuns({ ...workflowOf(workflowId) }).pipe(
    Effect.map((page) => page.value ?? []),
    Effect.provide(azure),
  );

/** Poll a workflow's runs until `until` holds. */
const pollRuns = (workflowId: string, until: (runs: readonly logic.WorkflowRun[]) => boolean) =>
  runsOf(workflowId).pipe(
    Effect.repeat({ schedule: Schedule.spaced("5 seconds"), until, times: 36 }),
  );

/** Every role on the Function's identity as `<actions> <scope>`, without its host-storage grants. */
const grantsOf = (principalId: string, hostStorageAccount: string | undefined) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    const host = `/storageaccounts/${(hostStorageAccount ?? "").toLowerCase()}`;
    const grants: string[] = [];
    for (const assignment of assignments) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      if (scope.endsWith(host)) continue;
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
  }).pipe(Effect.provide(azure));

describe("Azure Logic Apps bindings on an Azure Function", { tags }, () => {
  test(
    "each binding grants exactly its action on its own workflow",
    Effect.gen(function* () {
      const { principalId, hostStorageAccount, ticker, sleeper, resettable } = yield* stack;
      // Role-assignment lists trail the deploy by a few seconds.
      const grants = yield* grantsOf(principalId ?? "", hostStorageAccount).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (grants) => grants.length >= 3,
          times: 24,
        }),
      );
      expect(grants).toEqual(
        [
          `Microsoft.Logic/workflows/triggers/run/action ${ticker.toLowerCase()}`,
          `Microsoft.Logic/workflows/runs/cancel/action ${sleeper.toLowerCase()}`,
          `Microsoft.Logic/workflows/triggers/reset/action ${resettable.toLowerCase()}`,
        ].sort(),
      );
    }),
    { timeout: 600_000 },
  );

  describe("Logic.RunWorkflowTrigger", () => {
    test(
      "starts a run of the bound workflow",
      Effect.gen(function* () {
        const { ticker } = yield* stack;
        const body = yield* call("/run-trigger");
        expectOk(body);
        expect(body.result).toEqual("ran");
        const runs = yield* pollRuns(ticker, (runs) => runs.length > 0);
        expect(new Set(runs.map((run) => run.properties?.trigger?.name))).toEqual(
          new Set([TRIGGER]),
        );
      }),
      { timeout: 600_000 },
    );
  });

  describe("Logic.CancelWorkflowRun", () => {
    test(
      "cancels a running run of the bound workflow",
      Effect.gen(function* () {
        const { sleeper } = yield* stack;
        yield* logic
          .TriggerRunWorkflow({ ...workflowOf(sleeper), triggerName: TRIGGER })
          .pipe(Effect.provide(azure));
        const runs = yield* pollRuns(sleeper, (runs) =>
          runs.some((run) => run.properties?.status === "Running"),
        );
        const running = runs.find((run) => run.properties?.status === "Running")!;
        const body = yield* call(`/cancel-run?run=${running.name}`);
        expectOk(body);
        const after = yield* pollRuns(sleeper, (runs) =>
          runs.some((run) => run.name === running.name && run.properties?.status === "Cancelled"),
        );
        expect(after.find((run) => run.name === running.name)?.properties?.status).toEqual(
          "Cancelled",
        );
      }),
      { timeout: 600_000 },
    );
  });

  describe("Logic.ResetWorkflowTrigger", () => {
    test(
      "reaches the bound workflow's trigger, which has no state to reset",
      Effect.gen(function* () {
        const body = yield* call("/reset-trigger");
        expectOk(body);
        // ARM checks the caller's role before Logic Apps rejects the reset:
        // a missing grant answers `AuthorizationFailed` (a 500 here).
        expect(body.result).toEqual({ rejected: "WorkflowTriggerResetNotSupported" });
      }),
      { timeout: 600_000 },
    );
  });
});
