import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

export const LoadTest = Azure.LoadTesting.LoadTest("LtBindingsLoadTest", { location: "eastus" });
// Access tokens need local auth: with it disabled, the service answers 403
// `AccessTokenBasedAuthNotSupported`.
export const Workspace = Azure.LoadTesting.PlaywrightWorkspace("LtBindingsWorkspace", {
  location: "eastus",
  localAuth: "Enabled",
});

/** The test the load-test routes create, run, and delete. */
export const TEST_ID = "alchemy-bindings";
/** The test run the run routes start, stop, and delete. */
export const TEST_RUN_ID = "alchemy-bindings-run";
/** The JMeter script uploaded as the test's script. */
export const SCRIPT_NAME = "script.jmx";
/** The extra file uploaded and then deleted. */
export const DATA_NAME = "users.csv";

/** One thread, one request to example.com: the smallest script the service validates. */
export const JMX = `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="alchemy" enabled="true">
      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" enabled="true">
        <collectionProp name="Arguments.arguments"/>
      </elementProp>
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="users" enabled="true">
        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" enabled="true">
          <boolProp name="LoopController.continue_forever">false</boolProp>
          <stringProp name="LoopController.loops">1</stringProp>
        </elementProp>
        <stringProp name="ThreadGroup.num_threads">1</stringProp>
        <stringProp name="ThreadGroup.ramp_time">1</stringProp>
      </ThreadGroup>
      <hashTree>
        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="home" enabled="true">
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" enabled="true">
            <collectionProp name="Arguments.arguments"/>
          </elementProp>
          <stringProp name="HTTPSampler.domain">example.com</stringProp>
          <stringProp name="HTTPSampler.protocol">https</stringProp>
          <stringProp name="HTTPSampler.path">/</stringProp>
          <stringProp name="HTTPSampler.method">GET</stringProp>
        </HTTPSamplerProxy>
        <hashTree/>
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>
`;

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/** The `_tag` an effect fails with (`"none"` when it succeeds). */
const failureTag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as("none"),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

/**
 * Effect-native Azure Function exercising every Azure Load Testing and
 * Azure Playwright binding on a managed-identity host, one route per
 * binding. Routes answer `{ ok, result | error }` with a 500 on error, so a
 * caller retries through the cold start and role propagation, and a real
 * failure shows the Azure error.
 */
export default class LtBindingsFunction extends Azure.Functions.Function<LtBindingsFunction>()(
  "LtBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const loadTest = yield* LoadTest;
    const workspace = yield* Workspace;

    const createOrUpdateTest = yield* Azure.LoadTesting.CreateOrUpdateTest(loadTest);
    const getTest = yield* Azure.LoadTesting.GetTest(loadTest);
    const listTests = yield* Azure.LoadTesting.ListTests(loadTest);
    const deleteTest = yield* Azure.LoadTesting.DeleteTest(loadTest);
    const uploadTestFile = yield* Azure.LoadTesting.UploadTestFile(loadTest);
    const getTestFile = yield* Azure.LoadTesting.GetTestFile(loadTest);
    const listTestFiles = yield* Azure.LoadTesting.ListTestFiles(loadTest);
    const deleteTestFile = yield* Azure.LoadTesting.DeleteTestFile(loadTest);
    const createOrUpdateTestRun = yield* Azure.LoadTesting.CreateOrUpdateTestRun(loadTest);
    const getTestRun = yield* Azure.LoadTesting.GetTestRun(loadTest);
    const listTestRuns = yield* Azure.LoadTesting.ListTestRuns(loadTest);
    const stopTestRun = yield* Azure.LoadTesting.StopTestRun(loadTest);
    const deleteTestRun = yield* Azure.LoadTesting.DeleteTestRun(loadTest);
    const getTestRunFile = yield* Azure.LoadTesting.GetTestRunFile(loadTest);

    const createToken = yield* Azure.LoadTesting.CreatePlaywrightAccessToken(workspace);
    const getToken = yield* Azure.LoadTesting.GetPlaywrightAccessToken(workspace);
    const listTokens = yield* Azure.LoadTesting.ListPlaywrightAccessTokens(workspace);
    const deleteToken = yield* Azure.LoadTesting.DeletePlaywrightAccessToken(workspace);
    const listRuns = yield* Azure.LoadTesting.ListPlaywrightTestRuns(workspace);
    const createOrUpdateRun = yield* Azure.LoadTesting.CreateOrUpdatePlaywrightTestRun(workspace);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const id = url.searchParams.get("id") ?? "";
        const name = url.searchParams.get("name") ?? "";
        switch (url.pathname) {
          case "/test/create":
            return yield* respond(
              Effect.map(
                createOrUpdateTest({
                  testId: TEST_ID,
                  displayName: name,
                  description: "Created by the Alchemy binding tests",
                  kind: "JMX",
                  loadTestConfiguration: { engineInstances: 1 },
                }),
                (test) => ({ testId: test.testId, displayName: test.displayName }),
              ),
            );
          case "/test/get":
            return yield* respond(
              Effect.gen(function* () {
                const test = yield* getTest({ testId: TEST_ID });
                const missing = yield* failureTag(getTest({ testId: "alchemy-missing" }));
                return { testId: test.testId, displayName: test.displayName, missing };
              }),
            );
          case "/test/list":
            return yield* respond(
              Effect.map(listTests(), (page) => ({ testIds: page.value.map((t) => t.testId) })),
            );
          case "/test/delete":
            return yield* respond(Effect.as(deleteTest({ testId: TEST_ID }), { deleted: TEST_ID }));

          case "/file/upload":
            return yield* respond(
              Effect.gen(function* () {
                const script = yield* uploadTestFile({
                  testId: TEST_ID,
                  fileName: SCRIPT_NAME,
                  fileType: "JMX_FILE",
                  body: JMX,
                });
                const data = yield* uploadTestFile({
                  testId: TEST_ID,
                  fileName: DATA_NAME,
                  fileType: "ADDITIONAL_ARTIFACTS",
                  body: "user\nalice\n",
                });
                return { script: script.fileName, data: data.fileName, type: data.fileType };
              }),
            );
          case "/file/get":
            return yield* respond(
              Effect.map(getTestFile({ testId: TEST_ID, fileName: name }), (file) => ({
                fileName: file.fileName,
                fileType: file.fileType,
                validationStatus: file.validationStatus,
              })),
            );
          case "/file/list":
            return yield* respond(
              Effect.map(listTestFiles({ testId: TEST_ID }), (page) => ({
                fileNames: page.value.map((f) => f.fileName).sort(),
              })),
            );
          case "/file/delete":
            return yield* respond(
              Effect.as(deleteTestFile({ testId: TEST_ID, fileName: DATA_NAME }), {
                deleted: DATA_NAME,
              }),
            );

          case "/run/create":
            return yield* respond(
              Effect.map(
                createOrUpdateTestRun({
                  testRunId: TEST_RUN_ID,
                  testId: TEST_ID,
                  displayName: "alchemy bindings run",
                }),
                (run) => ({ testRunId: run.testRunId, testId: run.testId }),
              ),
            );
          case "/run/get":
            return yield* respond(
              Effect.gen(function* () {
                const run = yield* getTestRun({ testRunId: TEST_RUN_ID });
                const missing = yield* failureTag(getTestRun({ testRunId: "alchemy-missing" }));
                return { testRunId: run.testRunId, testId: run.testId, missing };
              }),
            );
          case "/run/list":
            return yield* respond(
              Effect.map(listTestRuns({ testId: TEST_ID }), (page) => ({
                testRunIds: page.value.map((r) => r.testRunId),
              })),
            );
          case "/run/stop":
            return yield* respond(
              Effect.map(stopTestRun({ testRunId: TEST_RUN_ID }), (run) => ({
                testRunId: run.testRunId,
                status: run.status,
              })),
            );
          case "/run/file":
            return yield* respond(
              Effect.map(
                getTestRunFile({ testRunId: TEST_RUN_ID, fileName: SCRIPT_NAME }),
                (f) => ({
                  fileName: f.fileName,
                  fileType: f.fileType,
                }),
              ),
            );
          case "/run/delete":
            return yield* respond(
              Effect.as(deleteTestRun({ testRunId: TEST_RUN_ID }), { deleted: TEST_RUN_ID }),
            );

          case "/token/create":
            return yield* respond(
              Effect.map(
                createToken({
                  accessTokenId: id,
                  name,
                  expiryAt: new Date(Date.now() + 86_400_000).toISOString(),
                }),
                (token) => ({
                  id: token.id,
                  name: token.name,
                  state: token.state,
                  hasJwt: (token.jwtToken ?? "").split(".").length === 3,
                }),
              ),
            );
          case "/token/get":
            return yield* respond(
              Effect.map(getToken({ accessTokenId: id }), (token) => ({
                id: token.id,
                name: token.name,
                state: token.state,
              })),
            );
          case "/token/list":
            return yield* respond(
              Effect.map(listTokens(), (page) => ({ ids: page.value.map((t) => t.id) })),
            );
          case "/token/delete":
            return yield* respond(
              Effect.gen(function* () {
                yield* deleteToken({ accessTokenId: id });
                // Once the token is gone, a read fails.
                const after = yield* failureTag(getToken({ accessTokenId: id }));
                return { after };
              }),
            );

          case "/pw-run/create":
            return yield* respond(
              Effect.map(
                createOrUpdateRun({
                  runId: id,
                  displayName: name,
                  config: { sdkLanguage: "TYPESCRIPT", maxWorkers: 1 },
                }),
                (run) => ({ runId: run.runId, displayName: run.displayName }),
              ),
            );
          case "/pw-run/list":
            return yield* respond(
              Effect.map(listRuns(), (page) => ({ runIds: page.value.map((r) => r.runId) })),
            );
        }
        return HttpServerResponse.text("not found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.LoadTesting.CreateOrUpdateTestHttp,
        Azure.LoadTesting.GetTestHttp,
        Azure.LoadTesting.ListTestsHttp,
        Azure.LoadTesting.DeleteTestHttp,
        Azure.LoadTesting.UploadTestFileHttp,
        Azure.LoadTesting.GetTestFileHttp,
        Azure.LoadTesting.ListTestFilesHttp,
        Azure.LoadTesting.DeleteTestFileHttp,
        Azure.LoadTesting.CreateOrUpdateTestRunHttp,
        Azure.LoadTesting.GetTestRunHttp,
        Azure.LoadTesting.ListTestRunsHttp,
        Azure.LoadTesting.StopTestRunHttp,
        Azure.LoadTesting.DeleteTestRunHttp,
        Azure.LoadTesting.GetTestRunFileHttp,
        Azure.LoadTesting.CreatePlaywrightAccessTokenHttp,
        Azure.LoadTesting.GetPlaywrightAccessTokenHttp,
        Azure.LoadTesting.ListPlaywrightAccessTokensHttp,
        Azure.LoadTesting.DeletePlaywrightAccessTokenHttp,
        Azure.LoadTesting.ListPlaywrightTestRunsHttp,
        Azure.LoadTesting.CreateOrUpdatePlaywrightTestRunHttp,
      ),
    ),
  ),
) {}
