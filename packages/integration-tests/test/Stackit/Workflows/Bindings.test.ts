import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workflows from "@distilled.cloud/stackit/workflows";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitEnvironment, stackitTags } from "../helpers.ts";
import WorkflowsBindingsWorker, { Airflow, BUNDLE, EXAMPLE_DAG } from "./fixtures/worker.ts";
import { noIdentityProvider, slow } from "./workflows.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitWorkflowsBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* WorkflowsBindingsWorker;
    const instance = yield* Airflow;
    return {
      url: worker.url.as<string>(),
      instanceId: instance.instanceId,
      instanceUrl: instance.url,
      displayName: instance.displayName,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// Gated behind STACKIT_TEST_SLOW: see `workflows.ts` for the cost. No test here has run: no STACKIT
// credentials exist yet.
describe.skipIf(slow)(
  "STACKIT Workflows bindings on a Cloudflare Worker",
  { tags: [...stackitTags("workflows", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 3_600_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 3_600_000 });

    // A fresh workers.dev URL, the created key and the account's new memberships take a while to
    // propagate, and Airflow takes a while to parse a DAG file: retry until the route answers
    // `ok`, then report the last answer so a real failure shows its error.
    const call = (route: string, params: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const query = new URLSearchParams(params).toString();
        return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
          Effect.timeout("30 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    const OPTIONS = { timeout: 300_000 } as const;

    describe("GetInstance", () => {
      test.provider(
        "reads the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId, instanceUrl } = yield* stack;
            const body = yield* call("/get-instance");
            expectOk(body);
            expect(body.result.id).toEqual(instanceId);
            expect(body.result.status).toEqual("active");
            expect(body.result.endpoints.url).toEqual(instanceUrl);
          }),
        OPTIONS,
      );
    });

    describe("ListInstances", () => {
      test.provider(
        "lists the deployed instance",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId, displayName } = yield* stack;
            const body = yield* call("/list-instances");
            expectOk(body);
            const found = body.result.instances.find(
              (instance: { id: string }) => instance.id === instanceId,
            );
            expect(found?.displayName).toEqual(displayName);
          }),
        OPTIONS,
      );
    });

    describe("ListDagBundles", () => {
      test.provider(
        "lists the deployed bundle",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-dag-bundles");
            expectOk(body);
            expect(body.result.dagBundles.map((bundle: { name: string }) => bundle.name)).toEqual([
              BUNDLE,
            ]);
          }),
        OPTIONS,
      );
    });

    describe("GetDagBundle", () => {
      test.provider(
        "reads the bound bundle",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/get-dag-bundle");
            expectOk(body);
            expect(body.result).toMatchObject({ type: "git", name: BUNDLE, branch: "3.1.8" });
          }),
        OPTIONS,
      );

      test.provider(
        "types a bundle that doesn't exist",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/get-missing-bundle");
            expectOk(body);
            expect(body.result).toEqual("NotFound");
          }),
        OPTIONS,
      );
    });

    describe("UpdateDagBundle", () => {
      test.provider(
        "changes the bundle, and leaves its other settings",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId } = yield* stack;
            const { projectId, region } = yield* stackitEnvironment;
            const body = yield* call("/update-dag-bundle", { interval: "180" });
            expectOk(body);
            expect(body.result.refreshInterval).toEqual(180);

            // Out of band.
            const live = yield* workflows.getDagBundle({
              projectId,
              regionId: region,
              instanceId,
              bundleName: BUNDLE,
            });
            expect(live).toMatchObject({ refreshInterval: 180, branch: "3.1.8" });
          }),
        OPTIONS,
      );
    });

    describe("GetProviderOptions", () => {
      test.provider(
        "reads the region's versions",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/get-provider-options");
            expectOk(body);
            expect(body.result.versions.length).toBeGreaterThan(0);
            expect(typeof body.result.versions[0].version).toEqual("string");
          }),
        OPTIONS,
      );
    });

    // These go through the instance's session endpoint, which needs an OAuth2 identity provider
    // with an API audience, and a client it issues tokens to.
    describe.skipIf(noIdentityProvider)("on Airflow's REST API", () => {
      const runId = `alchemy-${crypto.randomUUID()}`;

      describe("GetDag", () => {
        test.provider(
          "reads a DAG Airflow parsed",
          (_stack) =>
            Effect.gen(function* () {
              const body = yield* call("/get-dag");
              expectOk(body);
              expect(body.result.dag_id).toEqual(EXAMPLE_DAG);
              expect(body.result.has_import_errors).toEqual(false);
            }),
          OPTIONS,
        );
      });

      describe("PatchDag", () => {
        test.provider(
          "pauses and unpauses a DAG",
          (_stack) =>
            Effect.gen(function* () {
              const paused = yield* call("/patch-dag", { paused: "true" });
              expectOk(paused);
              expect(paused.result.is_paused).toEqual(true);
              const unpaused = yield* call("/patch-dag", { paused: "false" });
              expectOk(unpaused);
              expect(unpaused.result.is_paused).toEqual(false);
            }),
          OPTIONS,
        );
      });

      describe("SetVariable", () => {
        test.provider(
          "creates a variable, then updates it",
          (_stack) =>
            Effect.gen(function* () {
              const created = yield* call("/set-variable", { value: "first" });
              expectOk(created);
              expect(created.result.key).toEqual("alchemy_test");
              const updated = yield* call("/set-variable", { value: "second" });
              expectOk(updated);
              expect(updated.result.description).toEqual("alchemy test");
            }),
          OPTIONS,
        );
      });

      describe("SetConnection", () => {
        test.provider(
          "creates a connection, then updates what is sent and keeps the rest",
          (_stack) =>
            Effect.gen(function* () {
              const created = yield* call("/set-connection", {
                host: "one.example.com",
                password: "alchemy-test-password",
              });
              expectOk(created);
              expect(created.result.host).toEqual("one.example.com");
              // Airflow masks it, so the secret isn't in the answer.
              expect(JSON.stringify(created.result)).not.toContain("alchemy-test-password");
              const updated = yield* call("/set-connection", { host: "two.example.com" });
              expectOk(updated);
              expect(updated.result.host).toEqual("two.example.com");
            }),
          OPTIONS,
        );
      });

      describe("TriggerDagRun", () => {
        test.provider(
          "starts a run, and types a second one with its id",
          (_stack) =>
            Effect.gen(function* () {
              const unpaused = yield* call("/patch-dag", { paused: "false" });
              expectOk(unpaused);
              const body = yield* call("/trigger-dag-run", { run: runId });
              expectOk(body);
              expect(body.result).toMatchObject({
                dag_run_id: runId,
                dag_id: EXAMPLE_DAG,
                conf: { from: "alchemy" },
              });
              const duplicate = yield* call("/trigger-duplicate", { run: runId });
              expectOk(duplicate);
              expect(duplicate.result).toEqual("Conflict");
            }),
          OPTIONS,
        );
      });

      describe("GetDagRun", () => {
        test.provider(
          "follows the run to its end",
          (_stack) =>
            Effect.gen(function* () {
              // A new DAG starts paused, and a paused DAG's run doesn't start.
              const unpaused = yield* call("/patch-dag", { paused: "false" });
              expectOk(unpaused);
              const started = yield* call("/trigger-dag-run", {
                run: `${runId}-followed`,
              });
              expectOk(started);
              const finished = yield* call("/get-dag-run", { run: `${runId}-followed` }).pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("5 seconds"),
                  until: (body) => ["success", "failed"].includes(body.result?.state),
                  times: 90,
                }),
              );
              expectOk(finished);
              expect(finished.result.state).toEqual("success");
            }),
          { timeout: 600_000 },
        );

        test.provider(
          "types a run that doesn't exist",
          (_stack) =>
            Effect.gen(function* () {
              const body = yield* call("/get-missing-run");
              expectOk(body);
              expect(body.result).toEqual("NotFound");
            }),
          OPTIONS,
        );
      });

      describe("ListDagRuns", () => {
        test.provider(
          "lists a run it started",
          (_stack) =>
            Effect.gen(function* () {
              const id = `${runId}-listed`;
              const started = yield* call("/trigger-dag-run", { run: id });
              expectOk(started);
              const body = yield* call("/list-dag-runs");
              expectOk(body);
              expect(
                body.result.dag_runs.map((run: { dag_run_id: string }) => run.dag_run_id),
              ).toContain(id);
              expect(body.result.total_entries).toBeGreaterThan(0);
            }),
          OPTIONS,
        );
      });

      describe("ListTaskInstances", () => {
        test.provider(
          "reads the tasks of a run",
          (_stack) =>
            Effect.gen(function* () {
              const id = `${runId}-tasks`;
              const started = yield* call("/trigger-dag-run", { run: id });
              expectOk(started);
              const body = yield* call("/list-task-instances", { run: id }).pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("5 seconds"),
                  until: (answer) => (answer.result?.total_entries ?? 0) > 0,
                  times: 36,
                }),
              );
              expectOk(body);
              expect(body.result.task_instances[0]).toMatchObject({
                dag_id: EXAMPLE_DAG,
                dag_run_id: id,
                task_id: "my_task",
              });
            }),
          { timeout: 300_000 },
        );
      });
    });
  },
);
