import * as Azure from "@alchemy.run/azure";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
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
import MachineLearningFunction, { Instance } from "./fixtures/function.ts";
import { tags } from "./util.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureMachineLearningBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* MachineLearningFunction;
    const instance = yield* Instance;
    return { url: fn.url, computeId: instance.computeId };
  }),
);

/**
 * Compute instances do not provision on the testing subscription (see the
 * skipped compute-instance case in `Compute.test.ts`), so this suite does
 * not deploy. ~$0.10/run, 40 min once they do: a Standard_D2s_v3 instance
 * (~$0.10/hour) plus a Flex Consumption app.
 */
const RUN_COMPUTE_INSTANCES = false;

const stack = RUN_COMPUTE_INSTANCES ? beforeAll(deploy(Stack), { timeout: 3_600_000 }) : undefined;
if (RUN_COMPUTE_INSTANCES) afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** Deployer credentials and environment for out-of-band checks and hooks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: unknown; error?: string };

/** Call a binding route until it answers `ok` (cold start, role propagation). */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack!;
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

/** Poll the compute instance (deployer credentials) until its state is `state`. */
const untilState = (state: string) =>
  Effect.gen(function* () {
    const { computeId } = yield* stack!;
    const parts = computeId.split("/");
    return yield* ml
      .GetCompute({
        subscriptionId: parts[2] ?? "",
        resourceGroupName: parts[4] ?? "",
        workspaceName: parts[8] ?? "",
        computeName: parts[10] ?? "",
      })
      .pipe(
        Effect.map(
          (compute) => (compute.properties?.properties as { state?: string } | undefined)?.state,
        ),
        Effect.repeat({
          schedule: Schedule.spaced("15 seconds"),
          until: (observed) => observed === state,
          times: 40,
        }),
      );
  }).pipe(Effect.provide(azure));

// Skipped: compute instances stay in 'Creating' on the testing subscription
// (Azure.ProvisioningTimedOut: machine learning compute … did not reach
// 'Succeeded' after 150 polls (last state: Creating)).
describe.skip(
  "Azure Machine Learning bindings on an Azure Function",
  { tags, sequential: true },
  () => {
    describe("MachineLearning.StopCompute", () => {
      test(
        "stops the bound compute instance",
        Effect.gen(function* () {
          expectOk(yield* call("/stop"));
          expect(yield* untilState("Stopped")).toEqual("Stopped");
        }),
        { timeout: 900_000 },
      );
    });

    describe("MachineLearning.StartCompute", () => {
      test(
        "starts the bound compute instance",
        Effect.gen(function* () {
          expectOk(yield* call("/start"));
          expect(yield* untilState("Running")).toEqual("Running");
        }),
        { timeout: 900_000 },
      );
    });

    describe("MachineLearning.RestartCompute", () => {
      test(
        "restarts the bound compute instance",
        Effect.gen(function* () {
          expectOk(yield* call("/restart"));
          expect(yield* untilState("Running")).toEqual("Running");
        }),
        { timeout: 900_000 },
      );
    });
  },
);
