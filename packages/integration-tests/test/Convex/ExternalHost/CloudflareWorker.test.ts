import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Convex from "@alchemy.run/convex";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { BindingDeployment } from "../fixtures/resources.ts";
import ConvexBindingWorker from "../fixtures/worker.ts";
import { FIXTURE_DIR } from "../support.ts";

const pro = !!process.env.CONVEX_TEST_PRO;
const providers = Layer.mergeAll(Convex.providers(), Cloudflare.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "ConvexExternalWorkerStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const deployment = yield* BindingDeployment;
    yield* Convex.Functions("BindingFunctions", { deployment, rootDir: FIXTURE_DIR });
    const worker = yield* ConvexBindingWorker;
    return { url: worker.url.as<string>(), deploymentUrl: deployment.url };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const get = (path: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const res = yield* client
      .get(`${url}${path}`)
      .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
    return (yield* res.json) as { value?: any; tag?: string };
  });

const options = { timeout: 180_000 };

test(
  "Connect and functions run on a deployed Worker",
  Effect.gen(function* () {
    const { deploymentUrl } = yield* stack;
    expect((yield* get("/connect")).value.url).toBe(deploymentUrl);
    expect((yield* get("/add")).tag).toBeUndefined();
    const { value } = yield* get("/list");
    expect(value.map((row: { body: string }) => row.body)).toContain("from a worker");
    expect((yield* get("/batch")).value[1]).toBe("hello from the fixture");
    expect((yield* get("/ping")).value).toBe(42);
    expect((yield* get("/missing")).tag).toBe("ConvexFunctionError");
  }),
  options,
);

test(
  "a Worker's own deploy key reads usage",
  Effect.gen(function* () {
    expect((yield* get("/usage")).value.metrics.functionCalls).toBeTruthy();
  }),
  options,
);

test.skipIf(pro)(
  "plan-gated bindings fail with their typed tags",
  Effect.gen(function* () {
    expect((yield* get("/audit")).tag).toBe("AuditLogsTooOld");
    expect((yield* get("/sync")).tag).toBe("StreamingExportNotEnabled");
  }),
  options,
);
