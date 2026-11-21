import * as Hetzner from "@alchemy.run/hetzner";
import * as Railway from "@alchemy.run/railway";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetRailway from "@alchemy.run/rivet/Railway";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as RivetApi from "@distilled.cloud/rivet";
import * as Namespaces from "@distilled.cloud/rivet/namespaces";
import * as Pools from "@distilled.cloud/rivet/pools";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { conformanceTests, waitForReady } from "../Cloudflare/Workers/conformance/spec.ts";
import { railwayApi } from "../Railway/limit.ts";
import { suitePartition } from "../Railway/suiteProject.ts";
import { expectDurableStream } from "./fixtures/durable-stream-check.ts";
import { Cluster } from "./fixtures/railway/cluster.ts";
import { CounterLive } from "./fixtures/railway/counter-live.ts";
import Front from "./fixtures/railway/front.ts";
import { expectRustCounter, RustActors, rustTarget, type RustTarget } from "./fixtures/rust.ts";

const testOptions = {
  limit: railwayApi,
  providers: Layer.mergeAll(Hetzner.providers(), Railway.providers(), Rivet.providers()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` drains whatever a
// previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(testOptions, "RivetRailwayConformance", import.meta.url);

let baseUrl = "";
let rust: RustTarget;

// A Rust Durable Object on a pool of its own.
const RustPool = RivetRailway.ServicePool("Rust").pipe(Layer.provide(Cluster));

// The engine conformance spec, run against Rivet Durable Objects on a
// control plane on Hetzner and a pool of nodes on Railway, called from a Railway Service.
// Skipped: Railway is out of scope for now.
describe.skipIf(true)(
  "Rivet on Railway (Hetzner control plane, Railway Service pool)",
  { tags: ["provider:rivet", "provider:hetzner", "provider:railway", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        // NO_DESTROY keeps the stack between runs, so iterate on it.
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const front = yield* Front;
            const actors = yield* RustActors().pipe(Effect.provide(RustPool));
            return { url: front.url, rust: rustTarget(actors) };
          }).pipe(Effect.provide(CounterLive)),
        );
        const url = out.url;
        rust = out.rust as RustTarget;
        expect(url).toBeTruthy();
        baseUrl = String(url).replace(/\/+$/, "");
        yield* waitForReady(baseUrl, { attempts: 40, base: "3 seconds" });
      }),
      { timeout: 1_200_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 900_000 });

    conformanceTests(test, { baseUrl: () => baseUrl, kind: "live" });
    test(
      "Durable Streams: the front appends to and reads a stream on its cloud's Services pool",
      Effect.suspend(() => expectDurableStream(baseUrl)),
      { timeout: 180_000 },
    );

    test(
      "a Rust Durable Object runs on a Railway Service pool",
      Effect.gen(function* () {
        yield* expectRustCounter(rust, "railway-rust");
      }),
      { timeout: 300_000 },
    );
  },
);

// A single engine on a Railway Service, with its namespace and pool in the
// same stack. Railway answers for a Service that is starting or restarting
// with its own 404 page ("Application not found").
const engine = Effect.gen(function* () {
  const { project, environment } = yield* suitePartition;
  const token = yield* Random("EngineAdminToken", { bytes: 32 });
  const service = yield* Railway.Service("Engine", {
    project,
    environment,
    image: "rivetdev/engine:3.1.1",
    port: 6420,
    publicDomain: true,
    env: {
      RIVET__AUTH__ADMIN_TOKEN: token.text,
      RIVET__STORAGE__LOG_DIRECTORY: "/var/lib/rivet",
      RIVET__STORAGE__AUTO_PROVISION_PARTITIONS: "true",
      RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH: "/var/lib/rivet/objects",
      RIVET__TELEMETRY__ENABLED: "false",
    },
  });
  return { project, environment, token: token.text, service };
});

// Mounting the volume restarts the engine. The namespace is created once it
// is mounted, so it lands on the volume, through an engine that is restarting.
const engineWithPool = Effect.gen(function* () {
  const { project, environment, token, service } = yield* engine;
  const data = yield* Railway.Volume("EngineData", {
    project,
    environment,
    service,
    mountPath: "/var/lib/rivet",
  });
  const endpoint = Output.all(service.url, data.volumeId).pipe(
    Output.map(([url]) => url as string),
  );
  const namespace = yield* Rivet.Namespace("Ns", { endpoint, token });
  const pool = yield* Rivet.Pool("Pool", { endpoint, token, namespace: namespace.name });
  return { endpoint, token, namespace: namespace.name, pool: pool.name };
});

// The same namespace and pool, with the volume removed: that restarts the
// engine, and the destroy right after deletes the pool while it restarts.
const engineWithoutVolume = Effect.gen(function* () {
  const { token, service } = yield* engine;
  const endpoint = service.url.as<string>();
  const namespace = yield* Rivet.Namespace("Ns", { endpoint, token });
  yield* Rivet.Pool("Pool", { endpoint, token, namespace: namespace.name });
});

describe(
  "Rivet engine on a Railway Service",
  { tags: ["provider:rivet", "provider:railway", "live"] },
  () => {
    test.provider(
      "creates a namespace and pool, and deletes the pool, while the engine restarts",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const out = yield* stack.deploy(engineWithPool);
          const credentials = RivetApi.credentials({
            token: out.token as Redacted.Redacted<string>,
            endpoint: out.endpoint,
          });
          const getPool = Pools.getPool({ pool: out.pool, namespace: out.namespace }).pipe(
            Effect.map((res) => res.pool),
            Effect.catchTag("PoolNotFound", () => Effect.undefined),
            Effect.provide(credentials),
          );
          const namespaces = yield* Namespaces.listNamespaces({ name: out.namespace }).pipe(
            Effect.provide(credentials),
          );
          expect(namespaces.namespaces.map((ns) => ns.name)).toContain(out.namespace);
          expect((yield* getPool)?.name).toBe(out.pool);

          yield* stack.deploy(engineWithoutVolume);
          // Destroy once Railway answers for the restarting engine.
          const client = yield* HttpClient.HttpClient;
          yield* client.get(`${out.endpoint}/namespaces`).pipe(
            Effect.map((res) => res.status === 404 && res.headers["x-rivet-ray-id"] === undefined),
            Effect.orElseSucceed(() => false),
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (down) => down,
              times: 90,
            }),
          );
          yield* stack.destroy();
        }),
      { timeout: 900_000 },
    );
  },
);
