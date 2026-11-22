import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Convex from "@alchemy.run/convex";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { BindingDeployment } from "./fixtures/resources.ts";
import ConvexBindingWorker from "./fixtures/worker.ts";
import { FIXTURE_DIR } from "./support.ts";

const pro = !!process.env.CONVEX_TEST_PRO;
const providers = Layer.mergeAll(Convex.providers(), Cloudflare.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers, dev: true });

const Stack = Alchemy.Stack(
  "ConvexBindingsStack",
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
    return (yield* res.json) as { value?: any; tag?: string; message?: string };
  });

const options = { tags: ["provider:convex", "provider:convex:bindings", "live"], timeout: 120_000 };

test(
  "Connect gives the host the deployment's URLs",
  Effect.gen(function* () {
    const { deploymentUrl } = yield* stack;
    const { value } = yield* get("/connect");
    expect(value.url).toBe(deploymentUrl);
    expect(value.siteUrl).toContain("convex.site");
  }),
  options,
);

test(
  "Mutation and Query write and read a row",
  Effect.gen(function* () {
    expect((yield* get("/add")).tag).toBeUndefined();
    const { value } = yield* get("/list");
    expect(value.map((row: { body: string }) => row.body)).toContain("from a worker");
  }),
  options,
);

test(
  "QueryBatch runs several queries",
  Effect.gen(function* () {
    const { value } = yield* get("/batch");
    expect(value[1]).toBe("hello from the fixture");
  }),
  options,
);

test(
  "Action runs an action",
  Effect.gen(function* () {
    expect((yield* get("/ping")).value).toBe(42);
  }),
  options,
);

test(
  "a failing function is a typed error, not a success",
  Effect.gen(function* () {
    expect((yield* get("/missing")).tag).toBe("ConvexFunctionError");
  }),
  options,
);

test(
  "GetCurrentUsage reads the metrics",
  Effect.gen(function* () {
    const { value } = yield* get("/usage");
    expect(value.metrics.functionCalls).toBeTruthy();
  }),
  options,
);

test.skipIf(pro)(
  "ListAuditLogEvents needs a plan with audit logs",
  Effect.gen(function* () {
    expect((yield* get("/audit")).tag).toBe("AuditLogsTooOld");
  }),
  options,
);

test.skipIf(!pro)(
  "ListAuditLogEvents lists events",
  Effect.gen(function* () {
    expect(Array.isArray((yield* get("/audit")).value.items)).toBe(true);
  }),
  options,
);

test.skipIf(pro)(
  "DataSync needs the Professional plan",
  Effect.gen(function* () {
    expect((yield* get("/sync")).tag).toBe("StreamingExportNotEnabled");
  }),
  options,
);

test.skipIf(!pro)(
  "DataSync lists active syncs",
  Effect.gen(function* () {
    expect(Array.isArray((yield* get("/sync")).value.syncs)).toBe(true);
  }),
  options,
);

test.skipIf(!pro)(
  "DataSync exports a page of data",
  Effect.gen(function* () {
    yield* get("/add");
    const { value, tag, message } = yield* get("/export");
    expect(`${tag}: ${message}`).toBe("undefined: undefined");
    expect(value).toBeTruthy();
    expect(JSON.stringify(value)).toContain("from a worker");
  }),
  options,
);
