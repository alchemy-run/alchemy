import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitEnvironment, stackitTags } from "../helpers.ts";
import ModelExperimentsBindingsWorker, { Experiments, Tracking } from "./fixtures/worker.ts";
import { INSTANCE_TEST_TIMEOUT, observeInstance, slow } from "./modelExperiments.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitModelExperimentsBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* ModelExperimentsBindingsWorker;
    const instance = yield* Experiments;
    const tracking = yield* Tracking;
    return {
      url: worker.url.as<string>(),
      instanceId: instance.instanceId,
      tokenId: tracking.tokenId,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const OPTIONS = {
  tags: [...stackitTags("modelexperiments", "bindings"), "provider:cloudflare"],
  timeout: 240_000,
} as const;

// An instance is assumed to be billed per started hour: gated behind STACKIT_TEST_SLOW, like the
// suites of the same resources (see `modelExperiments.ts`). The cases share one MLflow history,
// so they run in order.
describe.sequential.skipIf(slow)(
  "STACKIT AI Model Experiments bindings on a Cloudflare Worker",
  { tags: [...stackitTags("modelexperiments", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: INSTANCE_TEST_TIMEOUT });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: INSTANCE_TEST_TIMEOUT });

    // A fresh workers.dev URL, the created key and the account's new memberships take a while to
    // propagate: retry until the route answers `ok`, then report the last answer so a real failure
    // shows its error.
    const call = (route: string, params: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const query = new URLSearchParams(params).toString();
        return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
          Effect.timeout("30 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    /** One experiment per case, named after it: names stay taken in MLflow's history. */
    const experiment = (name: string) =>
      call("/get-experiment-by-name", { name }).pipe(
        Effect.flatMap((found) =>
          found.ok
            ? Effect.succeed(found.result.experiment.experiment_id as string)
            : call("/create-experiment", { name }).pipe(
                Effect.tap((body) => Effect.sync(() => expectOk(body))),
                Effect.map((body) => body.result.experiment_id as string),
              ),
        ),
      );

    const newRun = (experimentId: string, name: string) =>
      call("/create-run", { experimentId, name }).pipe(
        Effect.tap((body) => Effect.sync(() => expectOk(body))),
        Effect.map((body) => body.result.run.info.run_id as string),
      );

    describe("GetInstance", () => {
      test.provider(
        "reads the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region } = yield* stackitEnvironment;
            const { instanceId } = yield* stack;
            const body = yield* call("/get-instance");
            expectOk(body);
            expect(body.result.instance.id).toEqual(instanceId);
            expect(body.result.instance.state).toEqual("active");
            // Out of band: the URL the binding reads is the one the API reports.
            const live = yield* observeInstance(projectId, region, instanceId);
            expect(live === "gone" ? "gone" : live.url).toEqual(body.result.instance.url);
          }),
        OPTIONS,
      );
    });

    describe("ListInstances", () => {
      test.provider(
        "lists the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId } = yield* stack;
            const body = yield* call("/list-instances");
            expectOk(body);
            expect(body.result.instances.map((item: { id: string }) => item.id)).toContain(
              instanceId,
            );
          }),
        OPTIONS,
      );
    });

    describe("GetToken", () => {
      test.provider(
        "reads the bound token, without its value",
        (_stack) =>
          Effect.gen(function* () {
            const { tokenId } = yield* stack;
            const body = yield* call("/get-token");
            expectOk(body);
            expect(body.result.token.id).toEqual(tokenId);
            expect(body.result.token.content).toBeUndefined();
          }),
        OPTIONS,
      );
    });

    describe("ListTokens", () => {
      test.provider(
        "lists the bound token",
        (_stack) =>
          Effect.gen(function* () {
            const { tokenId } = yield* stack;
            const body = yield* call("/list-tokens");
            expectOk(body);
            expect(body.result.tokens.map((item: { id: string }) => item.id)).toContain(tokenId);
          }),
        OPTIONS,
      );
    });

    describe("CreateExperiment", () => {
      test.provider(
        "creates an experiment, and types a taken name",
        (_stack) =>
          Effect.gen(function* () {
            const created = yield* call("/create-experiment", { name: "alchemy-create" });
            expectOk(created);
            expect(created.result.experiment_id).toEqual(expect.any(String));
            const taken = yield* call("/create-experiment-taken", { name: "alchemy-create" });
            expectOk(taken);
            expect(taken.result.taken).toBe(true);
          }),
        OPTIONS,
      );
    });

    describe("GetExperiment", () => {
      test.provider(
        "reads an experiment by id",
        (_stack) =>
          Effect.gen(function* () {
            const experimentId = yield* experiment("alchemy-get");
            const body = yield* call("/get-experiment", { experimentId });
            expectOk(body);
            expect(body.result.experiment.name).toEqual("alchemy-get");
          }),
        OPTIONS,
      );
    });

    describe("GetExperimentByName", () => {
      test.provider(
        "reads an experiment by name",
        (_stack) =>
          Effect.gen(function* () {
            const experimentId = yield* experiment("alchemy-by-name");
            const body = yield* call("/get-experiment-by-name", { name: "alchemy-by-name" });
            expectOk(body);
            expect(body.result.experiment.experiment_id).toEqual(experimentId);
          }),
        OPTIONS,
      );
    });

    describe("CreateRun", () => {
      test.provider(
        "starts a run",
        (_stack) =>
          Effect.gen(function* () {
            const experimentId = yield* experiment("alchemy-create-run");
            const body = yield* call("/create-run", { experimentId, name: "first" });
            expectOk(body);
            expect(body.result.run.info.status).toEqual("RUNNING");
            expect(body.result.run.info.run_name).toEqual("first");
          }),
        OPTIONS,
      );
    });

    describe("GetRun", () => {
      test.provider(
        "reads a run, and types a missing one",
        (_stack) =>
          Effect.gen(function* () {
            const experimentId = yield* experiment("alchemy-get-run");
            const runId = yield* newRun(experimentId, "read");
            const body = yield* call("/get-run", { runId });
            expectOk(body);
            expect(body.result.run.info.run_id).toEqual(runId);
            const missing = yield* call("/get-run-missing");
            expectOk(missing);
            expect(missing.result.missing).toBe(true);
          }),
        OPTIONS,
      );
    });

    describe("UpdateRun", () => {
      test.provider(
        "finishes a run",
        (_stack) =>
          Effect.gen(function* () {
            const experimentId = yield* experiment("alchemy-update-run");
            const runId = yield* newRun(experimentId, "finish");
            const body = yield* call("/update-run", { runId });
            expectOk(body);
            expect(body.result.run_info.status).toEqual("FINISHED");
            const read = yield* call("/get-run", { runId });
            expect(read.result.run.info.status).toEqual("FINISHED");
          }),
        OPTIONS,
      );
    });

    describe("LogMetric", () => {
      test.provider(
        "logs a metric the run then reports",
        (_stack) =>
          Effect.gen(function* () {
            const experimentId = yield* experiment("alchemy-log-metric");
            const runId = yield* newRun(experimentId, "metric");
            const logged = yield* call("/log-metric", { runId });
            expectOk(logged);
            const read = yield* call("/get-run", { runId });
            expectOk(read);
            expect(read.result.run.data.metrics).toMatchObject([
              { key: "loss", value: 0.5, step: 1 },
            ]);
          }),
        OPTIONS,
      );
    });

    describe("LogParam", () => {
      test.provider(
        "logs a param the run then reports, and types a changed value",
        (_stack) =>
          Effect.gen(function* () {
            const experimentId = yield* experiment("alchemy-log-param");
            const runId = yield* newRun(experimentId, "param");
            const logged = yield* call("/log-param", { runId });
            expectOk(logged);
            const read = yield* call("/get-run", { runId });
            expectOk(read);
            expect(read.result.run.data.params).toEqual([{ key: "lr", value: "0.1" }]);
            const changed = yield* call("/log-param-changed", { runId });
            expectOk(changed);
            expect(changed.result.conflict).toBe(true);
          }),
        OPTIONS,
      );
    });

    describe("SearchRuns", () => {
      test.provider(
        "finds a run by its metric",
        (_stack) =>
          Effect.gen(function* () {
            const experimentId = yield* experiment("alchemy-search-runs");
            const runId = yield* newRun(experimentId, "searched");
            const logged = yield* call("/log-metric", { runId });
            expectOk(logged);
            const body = yield* call("/search-runs", { experimentId });
            expectOk(body);
            expect(
              (body.result.runs ?? []).map((run: { info: { run_id: string } }) => run.info.run_id),
            ).toContain(runId);
          }),
        OPTIONS,
      );
    });
  },
);
