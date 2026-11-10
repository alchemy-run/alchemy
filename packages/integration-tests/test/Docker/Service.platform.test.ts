import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Docker from "@alchemy.run/docker";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { doWork, OtelCollector, waitForWorkSpan, withCollectorUrl } from "../Utils/Telemetry.ts";
import TestServiceV2Scaled from "./fixtures/service-v2-scaled.ts";
import TestServiceV2 from "./fixtures/service-v2.ts";
import TestService, { SERVICE_EXTERNAL_PORT } from "./fixtures/service.ts";
import TracedService, { TRACED_EXTERNAL_PORT } from "./fixtures/traced.ts";
import { ensureDockerSwarm } from "./Runtime.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Docker.providers(), Cloudflare.providers()),
});

// Full end-to-end for the effectful `Docker.Service` platform: bundle the
// fixture's Effect program, build the content-addressed image on the local
// engine, deploy it as a swarm service, and prove over HTTP that (a) the
// `{ fetch }` handler is served and (b) the `ServerHost.run` background loop
// is actually executing inside the swarm task (`/ticks` keeps climbing).
test.provider(
  "effectful service serves fetch and runs background loops",
  (stack) =>
    Effect.gen(function* () {
      yield* ensureDockerSwarm;
      yield* stack.destroy();

      const service = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* TestService;
        }),
      );

      expect(service.id.length).toBeGreaterThan(0);
      expect(service.replicas).toBe(1);
      // The bundled image is content-addressed: <physical-name>:<hash>.
      expect(service.code?.hash).toBeTruthy();
      expect(service.image).toContain(service.code!.hash);

      // The engine hands the resource's identity to the bundler, which writes
      // the bundle to the resource's own directory under `.alchemy` (and not
      // to a stray `dist/` in the package that contains `main`).
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dotAlchemy } = yield* AlchemyContext;
      const bundled = yield* fs.readFileString(
        path.join(
          dotAlchemy,
          "bundles",
          `${stack.name}-${stack.stage}-DockerPlatformService`,
          "index.mjs",
        ),
      );
      expect(bundled).toContain("/ticks");
      expect(service.ports).toEqual([
        {
          external: SERVICE_EXTERNAL_PORT,
          internal: 3000,
          protocol: "tcp",
          mode: "ingress",
        },
      ]);

      // The swarm ingress publishes the fixed external port on the local
      // node. Retry through task startup (image already local, so this is
      // just container boot + routing-mesh programming).
      const base = `http://localhost:${SERVICE_EXTERNAL_PORT}`;
      const health = yield* HttpClient.get(`${base}/health`).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new Error(`/health returned ${res.status}`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
      );
      expect(yield* health.json).toEqual({ ok: true });

      // Prove the ServerHost.run background loop is executing in-container:
      // the tick counter climbs between two reads.
      const readTicks = HttpClient.get(`${base}/ticks`).pipe(
        Effect.flatMap((res) => res.json),
        Effect.map((body) => (body as { ticks: number }).ticks),
      );
      const first = yield* readTicks;
      const second = yield* readTicks.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (ticks) => ticks > first,
          times: 10,
        }),
      );
      expect(second).toBeGreaterThan(first);

      // Redeploy with unchanged code: the diff is a noop (no replacement,
      // same service id, same content hash).
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* TestService;
        }),
      );
      expect(redeployed.id).toBe(service.id);
      expect(redeployed.code?.hash).toBe(service.code?.hash);

      // A code change rolls the same service onto the new content-addressed
      // image and drops the image built for the previous bundle.
      const updatePlan = yield* stack.plan(
        Effect.gen(function* () {
          return yield* TestServiceV2;
        }),
      );
      expect(updatePlan.resources.DockerPlatformService).toMatchObject({ action: "update" });
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* TestServiceV2;
        }),
      );
      expect(updated.id).toBe(service.id);
      expect(updated.code?.hash).not.toBe(service.code?.hash);
      expect(updated.image).toContain(updated.code!.hash);

      const v2 = yield* HttpClient.get(`${base}/health`).pipe(
        Effect.flatMap((res) => res.json),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (body) => (body as { version?: number }).version === 2,
          times: 30,
        }),
      );
      expect(v2).toEqual({ ok: true, version: 2 });

      const docker = yield* Docker.Docker;
      const previousImageGone = yield* docker.image.inspect(service.image).pipe(
        Effect.map(() => false),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(true)),
      );
      expect(previousImageGone).toBe(true);

      // A non-code update keeps the content hash and must not remove the
      // image the service is running.
      const scaled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* TestServiceV2Scaled;
        }),
      );
      expect(scaled.id).toBe(service.id);
      expect(scaled.replicas).toBe(2);
      expect(scaled.code?.hash).toBe(updated.code?.hash);
      const runningImagePresent = yield* docker.image.inspect(scaled.image).pipe(
        Effect.map(() => true),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      );
      expect(runningImagePresent).toBe(true);

      const imageRef = scaled.image;
      yield* stack.destroy();

      // The swarm service is gone after destroy.
      const gone = yield* docker.service.inspect(service.id).pipe(
        Effect.map(() => false),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);

      // The content-addressed image built for the bundled program was
      // cleaned up with the service.
      const imageGone = yield* docker.image.inspect(imageRef).pipe(
        Effect.map(() => false),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(true)),
      );
      expect(imageGone).toBe(true);
    }),
  {
    tags: ["provider:docker", "provider:docker:service", "local"],
    timeout: 420_000,
  },
);

// The collector is a live Cloudflare Worker: the swarm task exports to it
// over the internet, as a deployed service would.
test.provider(
  "effectful service exports spans to the bound OTLP destination",
  (stack) =>
    Effect.gen(function* () {
      yield* ensureDockerSwarm;
      yield* stack.destroy();

      // The traced program binds the collector url at deploy, so it deploys first.
      const collector = yield* stack.deploy(OtelCollector());
      yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* OtelCollector();
            return yield* TracedService;
          }),
        )
        .pipe(withCollectorUrl(collector.url!));

      expect(yield* doWork(`http://localhost:${TRACED_EXTERNAL_PORT}`, "docker")).toBe(
        "did work docker",
      );
      const traces = yield* waitForWorkSpan(collector.url!, "docker");
      expect(traces).toContain("work:docker");
      expect(traces).toContain("docker-service-e2e");

      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:docker",
      "provider:docker:service",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 300_000,
  },
);
