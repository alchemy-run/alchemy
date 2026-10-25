import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as loadtesting from "@distilled.cloud/azure/loadtesting-data";
import * as playwright from "@distilled.cloud/azure/loadtesting-playwright";
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
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import LtBindingsFunction, {
  DATA_NAME,
  LoadTest,
  SCRIPT_NAME,
  TEST_ID,
  TEST_RUN_ID,
  Workspace,
} from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Built-in **Load Test Owner**: the deployer's out-of-band data-plane access. */
const LOAD_TEST_OWNER = "45bb0b16-2f0c-4e78-afaa-a07599b003f6";

/** Object ID (`oid` claim) of the identity running the tests. */
const callerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureLoadTestingBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* LtBindingsFunction;
    const loadTest = yield* LoadTest;
    const workspace = yield* Workspace;
    // Lets the deployer verify each binding's effect through the data plane.
    const deployer = yield* callerObjectId.pipe(Effect.orDie);
    yield* Azure.Authorization.RoleAssignment("LtDeployerLoadTestOwner", {
      scope: loadTest.loadTestId,
      roleDefinitionId: LOAD_TEST_OWNER,
      principalId: deployer,
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      loadTestId: loadTest.loadTestId,
      dataPlaneUri: loadTest.dataPlaneUri,
      workspaceArmId: workspace.playwrightWorkspaceId,
      workspaceId: workspace.workspaceId,
      dataplaneUri: workspace.dataplaneUri,
    };
  }),
);

// ~$0.05/run (Flex Consumption, a load test resource and a Playwright
// workspace for ~15 min, one engine for under a minute); ~5 min deploy.
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
const call = (route: string, times = 48) =>
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

/** Run a `loadtesting-data` call as the deployer against the bound load test. */
const asDeployer = <A, E>(f: (endpoint: string) => Effect.Effect<A, E, any>) =>
  Effect.gen(function* () {
    const { dataPlaneUri } = yield* stack;
    return yield* f(dataPlaneUri ?? "") as Effect.Effect<A, E>;
  }).pipe(Effect.provide(azure));

/** Run a `loadtesting-playwright` test-run call as the deployer against the bound workspace. */
const asPlaywrightDeployer = <A, E>(
  f: (target: { endpoint: string; workspaceId: string }) => Effect.Effect<A, E, any>,
) =>
  Effect.gen(function* () {
    const { dataplaneUri, workspaceId } = yield* stack;
    // Test runs live on the reporting host.
    const host = new URL(dataplaneUri ?? "").host.replace(/^([^.]+)\.api\./, "$1.reporting.api.");
    const endpoint = `https://${host}`;
    return yield* f({ endpoint, workspaceId: workspaceId ?? "" }) as Effect.Effect<A, E>;
  }).pipe(Effect.provide(azure));

/** The `_tag` an effect fails with (`"found"` when it succeeds). */
const tagOf = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as("found"),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

/** Role assignments of the Function's identity, without its own host-storage grants. */
const assignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    return Array.from(assignments).filter(
      (a) => !/\/storageaccounts\/[^/]+$/.test(a.properties?.scope?.toLowerCase() ?? ""),
    );
  });

/** Number of roles the fixture's bindings assign (one per custom role). */
const EXPECTED_GRANTS = 9;

/** Every role on the Function's identity as `<permissions> <scope>`. */
const grantsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    // Lists of a new identity's assignments trail the writes by seconds.
    const assignments = yield* assignmentsOf(principalId).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (found) => found.length >= EXPECTED_GRANTS,
        times: 12,
      }),
    );
    const grants: string[] = [];
    for (const assignment of assignments) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      const permissions = (definition.properties?.permissions ?? [])
        .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
        .map((a) => a.replace(/^Microsoft\.LoadTestService\//, ""))
        .sort()
        .join("+");
      grants.push(`${permissions} ${scope}`);
    }
    return grants.sort();
  });

const ACCESS_TOKEN_ID = "6f1c1d2e-3a4b-4c5d-8e9f-a0b1c2d3e4f5";
const PLAYWRIGHT_RUN_ID = "0d9c8b7a-6f5e-4d3c-9b2a-1f0e9d8c7b6a";

describe(
  "Azure Load Testing and Playwright bindings on an Azure Function",
  { tags: ["provider:azure", "live"] },
  () => {
    describe("LoadTesting.CreateOrUpdateTest", () => {
      test(
        "creates the test",
        Effect.gen(function* () {
          const body = yield* call("/test/create?name=Bindings");
          expectOk(body);
          expect(body.result).toEqual({ testId: TEST_ID, displayName: "Bindings" });
          const observed = yield* asDeployer((endpoint) =>
            loadtesting.GetLoadTestAdministrationTest({ endpoint, testId: TEST_ID }),
          );
          expect(observed.displayName).toEqual("Bindings");
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.GetTest", () => {
      test(
        "reads the test; a missing test fails typed",
        Effect.gen(function* () {
          const body = yield* call("/test/get");
          expectOk(body);
          expect(body.result).toEqual({
            testId: TEST_ID,
            displayName: "Bindings",
            missing: "LoadTestNotFound",
          });
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.ListTests", () => {
      test(
        "lists the test",
        Effect.gen(function* () {
          const body = yield* call("/test/list");
          expectOk(body);
          const observed = yield* asDeployer((endpoint) =>
            loadtesting.ListLoadTestAdministrationTests({ endpoint }),
          );
          expect(body.result.testIds).toEqual([TEST_ID]);
          expect(observed.value.map((t) => t.testId)).toEqual([TEST_ID]);
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.UploadTestFile", () => {
      test(
        "uploads the script and a data file",
        Effect.gen(function* () {
          const body = yield* call("/file/upload");
          expectOk(body);
          expect(body.result).toEqual({
            script: SCRIPT_NAME,
            data: DATA_NAME,
            type: "ADDITIONAL_ARTIFACTS",
          });
          const observed = yield* asDeployer((endpoint) =>
            loadtesting.GetLoadTestAdministrationTestFile({
              endpoint,
              testId: TEST_ID,
              fileName: DATA_NAME,
            }),
          );
          expect(observed.fileType).toEqual("ADDITIONAL_ARTIFACTS");
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.GetTestFile", () => {
      test(
        "reads the script once the service validated it",
        Effect.gen(function* () {
          // Validation runs after the upload (about a minute).
          const status = yield* call(`/file/get?name=${SCRIPT_NAME}`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (body) => body.result?.validationStatus !== "VALIDATION_INITIATED",
              times: 30,
            }),
          );
          expectOk(status);
          expect(status.result).toEqual({
            fileName: SCRIPT_NAME,
            fileType: "JMX_FILE",
            validationStatus: "VALIDATION_SUCCESS",
          });
        }),
        { timeout: 600_000 },
      );
    });

    describe("LoadTesting.ListTestFiles", () => {
      test(
        "lists both files",
        Effect.gen(function* () {
          const body = yield* call("/file/list");
          expectOk(body);
          expect(body.result.fileNames).toEqual([SCRIPT_NAME, DATA_NAME].sort());
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.DeleteTestFile", () => {
      test(
        "deletes the data file",
        Effect.gen(function* () {
          const body = yield* call("/file/delete");
          expectOk(body);
          const after = yield* asDeployer((endpoint) =>
            tagOf(
              loadtesting.GetLoadTestAdministrationTestFile({
                endpoint,
                testId: TEST_ID,
                fileName: DATA_NAME,
              }),
            ),
          );
          expect(after).toEqual("LoadTestFileNotFound");
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.CreateOrUpdateTestRun", () => {
      test(
        "starts a run of the test",
        Effect.gen(function* () {
          const body = yield* call("/run/create");
          expectOk(body);
          expect(body.result).toEqual({ testRunId: TEST_RUN_ID, testId: TEST_ID });
          const observed = yield* asDeployer((endpoint) =>
            loadtesting.GetLoadTestRunTestRun({ endpoint, testRunId: TEST_RUN_ID }),
          );
          expect(observed.testId).toEqual(TEST_ID);
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.StopTestRun", () => {
      test(
        "stops the run",
        Effect.gen(function* () {
          const body = yield* call("/run/stop");
          expectOk(body);
          expect(body.result.testRunId).toEqual(TEST_RUN_ID);
          const status = yield* asDeployer((endpoint) =>
            loadtesting.GetLoadTestRunTestRun({ endpoint, testRunId: TEST_RUN_ID }).pipe(
              Effect.map((run) => run.status),
              Effect.repeat({
                schedule: Schedule.spaced("10 seconds"),
                until: (s) => s === "CANCELLED",
                times: 30,
              }),
            ),
          );
          expect(status).toEqual("CANCELLED");
        }),
        { timeout: 600_000 },
      );
    });

    describe("LoadTesting.GetTestRun", () => {
      test(
        "reads the run; a missing run fails typed",
        Effect.gen(function* () {
          const body = yield* call("/run/get");
          expectOk(body);
          expect(body.result).toEqual({
            testRunId: TEST_RUN_ID,
            testId: TEST_ID,
            missing: "LoadTestRunNotFound",
          });
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.ListTestRuns", () => {
      test(
        "lists the run",
        Effect.gen(function* () {
          const body = yield* call("/run/list");
          expectOk(body);
          expect(body.result.testRunIds).toEqual([TEST_RUN_ID]);
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.GetTestRunFile", () => {
      test(
        "reads the run's copy of the script",
        Effect.gen(function* () {
          const body = yield* call("/run/file");
          expectOk(body);
          expect(body.result).toEqual({ fileName: SCRIPT_NAME, fileType: "JMX_FILE" });
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.DeleteTestRun", () => {
      test(
        "deletes the run",
        Effect.gen(function* () {
          const body = yield* call("/run/delete");
          expectOk(body);
          const after = yield* asDeployer((endpoint) =>
            tagOf(loadtesting.GetLoadTestRunTestRun({ endpoint, testRunId: TEST_RUN_ID })),
          );
          expect(after).toEqual("LoadTestRunNotFound");
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.DeleteTest", () => {
      test(
        "deletes the test",
        Effect.gen(function* () {
          const body = yield* call("/test/delete");
          expectOk(body);
          const after = yield* asDeployer((endpoint) =>
            tagOf(loadtesting.GetLoadTestAdministrationTest({ endpoint, testId: TEST_ID })),
          );
          expect(after).toEqual("LoadTestNotFound");
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.CreatePlaywrightAccessToken", () => {
      test(
        "creates a token and returns its JWT once",
        Effect.gen(function* () {
          const body = yield* call(`/token/create?id=${ACCESS_TOKEN_ID}&name=alchemy`);
          expectOk(body);
          expect(body.result).toEqual({
            id: ACCESS_TOKEN_ID,
            name: "alchemy",
            state: "Active",
            hasJwt: true,
          });
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.GetPlaywrightAccessToken", () => {
      test(
        "reads the token",
        Effect.gen(function* () {
          const body = yield* call(`/token/get?id=${ACCESS_TOKEN_ID}`);
          expectOk(body);
          expect(body.result).toEqual({ id: ACCESS_TOKEN_ID, name: "alchemy", state: "Active" });
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.ListPlaywrightAccessTokens", () => {
      test(
        "lists the token",
        Effect.gen(function* () {
          const body = yield* call("/token/list");
          expectOk(body);
          expect(body.result.ids).toEqual([ACCESS_TOKEN_ID]);
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.DeletePlaywrightAccessToken", () => {
      test(
        "deletes the token",
        Effect.gen(function* () {
          const body = yield* call(`/token/delete?id=${ACCESS_TOKEN_ID}`);
          expectOk(body);
          expect(body.result).toEqual({ after: "NotFound" });
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.CreateOrUpdatePlaywrightTestRun", () => {
      test(
        "records a test run",
        Effect.gen(function* () {
          const body = yield* call(`/pw-run/create?id=${PLAYWRIGHT_RUN_ID}&name=alchemy-run`);
          expectOk(body);
          expect(body.result).toEqual({ runId: PLAYWRIGHT_RUN_ID, displayName: "alchemy-run" });
          const observed = yield* asPlaywrightDeployer((target) => playwright.ListTestRuns(target));
          expect(observed.value.map((run) => run.runId)).toContain(PLAYWRIGHT_RUN_ID);
        }),
        { timeout: 400_000 },
      );
    });

    describe("LoadTesting.ListPlaywrightTestRuns", () => {
      test(
        "lists the recorded run",
        Effect.gen(function* () {
          const body = yield* call("/pw-run/list");
          expectOk(body);
          expect(body.result.runIds).toContain(PLAYWRIGHT_RUN_ID);
        }),
        { timeout: 400_000 },
      );
    });

    describe("AzureBindings.Bind least privilege", () => {
      test(
        "assigns exactly each binding's permission, scoped to the bound resource",
        Effect.gen(function* () {
          const outputs = yield* stack;
          expect(outputs.principalId).toMatch(/^[0-9a-f-]{36}$/);
          const grants = yield* grantsOf(outputs.principalId!).pipe(Effect.provide(azure));
          const loadTest = outputs.loadTestId.toLowerCase();
          const workspace = outputs.workspaceArmId.toLowerCase();
          expect(grants).toEqual(
            [
              `loadtests/readTest/action ${loadTest}`,
              `loadtests/writeTest/action ${loadTest}`,
              `loadtests/deleteTest/action ${loadTest}`,
              `loadtests/startTest/action ${loadTest}`,
              `loadtests/stopTest/action ${loadTest}`,
              `playwrightWorkspaces/Read ${workspace}`,
              `playwrightWorkspaces/AccessTokens/Write ${workspace}`,
              `playwrightWorkspaces/TestRuns/Read ${workspace}`,
              `playwrightWorkspaces/TestRuns/Write ${workspace}`,
            ].sort(),
          );
        }),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then prove every role assigned to the Function's identity is gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId } = yield* stack;
    yield* destroy(Stack);
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const remaining = yield* assignmentsOf(principalId!).pipe(
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
