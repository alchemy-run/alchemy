import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
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
import StreamAnalyticsFunction, { Job, SCALED_UNITS } from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const tags = ["provider:azure", "provider:azure:streamanalytics", "live"];

const Stack = Alchemy.Stack(
  "AzureStreamAnalyticsBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* StreamAnalyticsFunction;
    const job = yield* Job;
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      jobId: job.streamingJobId,
      jobName: job.jobName,
      resourceGroup: job.resourceGroup,
    };
  }),
);

// The job runs on 1 then 3 streaming units for ~5 minutes (~$0.05), plus
// a storage account and a Flex Consumption app (~$0.01/run); ~5 min deploy.
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
      Effect.timeout("90 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** The job with its transformation (deployer credentials). */
const observeJob = Effect.gen(function* () {
  const { jobName, resourceGroup } = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  return yield* streamanalytics.GetStreamingJob({
    subscriptionId,
    resourceGroupName: resourceGroup,
    jobName,
    _expand: "transformation",
  });
}).pipe(Effect.provide(azure));

/** Poll the job until its state is `state` (starting takes a minute or two). */
const untilJobState = (state: string) =>
  observeJob.pipe(
    Effect.map((job) => job.properties?.jobState),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (observed) => observed === state,
      times: 30,
    }),
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

// Sequential: start, scale and stop act on the one job in that order.
describe.sequential("Azure Stream Analytics bindings on an Azure Function", { tags }, () => {
  test(
    "each binding grants exactly its action on the job",
    Effect.gen(function* () {
      const { principalId, hostStorageAccount, jobId } = yield* stack;
      const job = jobId.toLowerCase();
      const expected = [
        `Microsoft.StreamAnalytics/streamingjobs/Start/action ${job}`,
        `Microsoft.StreamAnalytics/streamingjobs/Scale/action ${job}`,
        `Microsoft.StreamAnalytics/streamingjobs/Stop/action ${job}`,
      ].sort();
      // Role-assignment lists trail the deploy by a few seconds.
      const grants = yield* grantsOf(principalId ?? "", hostStorageAccount).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (grants) => grants.length >= expected.length,
          times: 24,
        }),
      );
      expect(grants).toEqual(expected);
    }),
    { timeout: 600_000 },
  );

  describe("StreamAnalytics.StartStreamingJob", () => {
    test(
      "starts the bound job",
      Effect.gen(function* () {
        const body = yield* call("/start");
        expectOk(body);
        expect(yield* untilJobState("Running")).toEqual("Running");
      }),
      { timeout: 900_000 },
    );
  });

  describe("StreamAnalytics.ScaleStreamingJob", () => {
    test(
      "scales the running job's streaming units",
      Effect.gen(function* () {
        const body = yield* call("/scale");
        expectOk(body);
        const scaled = yield* observeJob.pipe(
          Effect.map((job) => job.properties?.transformation?.properties?.streamingUnits),
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (units) => units === SCALED_UNITS,
            times: 30,
          }),
        );
        expect(scaled).toEqual(SCALED_UNITS);
      }),
      { timeout: 900_000 },
    );
  });

  describe("StreamAnalytics.StopStreamingJob", () => {
    test(
      "stops the bound job",
      Effect.gen(function* () {
        const body = yield* call("/stop");
        expectOk(body);
        expect(yield* untilJobState("Stopped")).toEqual("Stopped");
      }),
      { timeout: 900_000 },
    );
  });
});
