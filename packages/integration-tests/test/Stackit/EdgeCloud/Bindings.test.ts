import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as edge from "@distilled.cloud/stackit/edge";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitEnvironment, stackitTags } from "../helpers.ts";
import { slow } from "./edge.ts";
import EdgeDiscoveryWorker from "./fixtures/discovery-worker.ts";
import EdgeBindingsWorker, { Bound } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const DiscoveryStack = Alchemy.Stack(
  "StackitEdgeDiscoveryStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* EdgeDiscoveryWorker;
    return { url: worker.url.as<string>() };
  }),
);

const InstanceStack = Alchemy.Stack(
  "StackitEdgeBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* EdgeBindingsWorker;
    const instance = yield* Bound;
    return {
      url: worker.url.as<string>(),
      projectId: instance.projectId,
      region: instance.region,
      instanceId: instance.instanceId,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/**
 * A fresh workers.dev URL, the created key and the account's memberships take a while to
 * propagate: retry until the route answers `ok`, then report the last answer so a real failure
 * shows its STACKIT error.
 */
const callWorker = (url: string, route: string, params: Record<string, string> = {}) =>
  HttpClient.get(`${url}${route}?${new URLSearchParams(params).toString()}`).pipe(
    Effect.timeout("20 seconds"),
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as Body),
    Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
    Effect.catch((body) => Effect.succeed(body as Body)),
  );

// No test here has run: no STACKIT account exists yet. The discovery host needs no instance, and
// so no entitlement.
describe(
  "STACKIT Edge Cloud discovery bindings on a Cloudflare Worker",
  { tags: [...stackitTags("edgecloud", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(DiscoveryStack), { timeout: 300_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(DiscoveryStack), { timeout: 300_000 });

    describe("ListPlans", () => {
      test.provider(
        "lists what the project can use, the same as the API does",
        (_stack) =>
          Effect.gen(function* () {
            const { url } = yield* stack;
            const { projectId } = yield* stackitEnvironment;
            const body = yield* callWorker(url!, "/list-plans", { projectId });
            expectOk(body);
            const direct = yield* edge.listPlansProject({ projectId });
            expect(body.result.validPlans).toEqual(direct.validPlans);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListCompatibleKubernetesReleases", () => {
      test(
        "answers a Talos release it doesn't know with the typed NotFound",
        Effect.gen(function* () {
          const { url } = yield* stack;
          const body = yield* callWorker(url!, "/list-compatible-releases", {
            talosVersion: "v0.0.0-alchemy-test",
          });
          expectOk(body);
          expect(body.result).toEqual({ notFound: true });
        }),
        { timeout: 240_000 },
      );
    });
  },
);

// `blocked: cost`: one instance. See `edge.ts`. Gated behind STACKIT_TEST_SLOW and
// STACKIT_TEST_EDGE.
describe.skipIf(slow)(
  "STACKIT Edge Cloud instance bindings on a Cloudflare Worker",
  { tags: [...stackitTags("edgecloud", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(InstanceStack), { timeout: 900_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(InstanceStack), { timeout: 900_000 });

    const call = (route: string) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        return yield* callWorker(url!, route);
      });

    describe("GetInstance", () => {
      test.provider(
        "reads the bound instance, the same as the API does",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, instanceId } = yield* stack;
            const body = yield* call("/get-instance");
            expectOk(body);
            const direct = yield* edge.getInstance({
              projectId: projectId!,
              regionId: region!,
              instanceId: instanceId!,
            });
            expect(body.result.id).toEqual(direct.id);
            expect(body.result.displayName).toEqual(direct.displayName);
            expect(body.result.status).toEqual("active");
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListInstances", () => {
      test(
        "lists the bound instance",
        Effect.gen(function* () {
          const { instanceId } = yield* stack;
          const body = yield* call("/list-instances");
          expectOk(body);
          expect(body.result.instances.map((entry: any) => entry.id)).toContain(instanceId);
        }),
        { timeout: 240_000 },
      );
    });

    describe("GetKubeconfig", () => {
      test(
        "mints a kubeconfig that stays redacted",
        Effect.gen(function* () {
          const body = yield* call("/get-kubeconfig");
          expectOk(body);
          expect(body.result.redacted).toBe(true);
          expect(body.result.clusters).toBeGreaterThan(0);
        }),
        { timeout: 240_000 },
      );
    });

    describe("GetToken", () => {
      test(
        "mints a token that stays redacted",
        Effect.gen(function* () {
          const body = yield* call("/get-token");
          expectOk(body);
          expect(body.result).toEqual({ redacted: true, minted: true });
        }),
        { timeout: 240_000 },
      );
    });
  },
);
