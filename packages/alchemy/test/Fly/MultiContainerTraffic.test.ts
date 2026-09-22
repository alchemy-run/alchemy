import * as machines from "@distilled.cloud/fly-io/machines";
import { currentFile, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { FileSystem } from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Fly from "@/Fly";
import { ReplicaChecksNotPassing } from "@/Fly/replicas";
import * as Test from "@/Test/Alchemy";
import type { ScratchStack } from "@/Test/Alchemy";
import { scratchStack } from "@/Test/Core";

const options = { providers: Fly.providers() };
const { test, beforeAll, afterAll } = Test.make(options);
const orgSlug = process.env.FLY_ORG;
const image =
  "docker-hub-mirror.fly.io/library/node@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85";

const scenario = (stack: ScratchStack) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path.Path;
    const script = yield* fs.readFileString(
      yield* path.fromFileUrl(
        new URL("./fixtures/multi-container-http.mjs", import.meta.url),
      ),
    );
    return (version: string, badHealth = false) =>
      stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("Traffic", { orgSlug });
          yield* Fly.IpAssignment("Public", { app, type: "shared_v4" });
          return yield* Fly.Machine("Group", {
            app,
            region: "fra",
            guest: { cpus: 1, memoryMb: 256 },
            containers: [
              {
                name: "web",
                image,
                cmd: ["node", "--input-type=module", "-e", script],
                env: { PORT: "3000", CONTAINER_NAME: "web", VERSION: version },
              },
              {
                name: "sidecar",
                image,
                cmd: ["node", "--input-type=module", "-e", script],
                env: {
                  PORT: "3001",
                  CONTAINER_NAME: "sidecar",
                  VERSION: version,
                  BAD_HEALTH: String(badHealth),
                },
                dependsOn: [{ name: "web", condition: "started" }],
              },
            ],
            checks: {
              sidecar: {
                type: "http",
                port: 3001,
                path: "/health",
                interval: "2s",
                timeout: "1s",
              },
            },
            services: [
              {
                protocol: "tcp",
                internalPort: 3000,
                ports: [{ port: 443, handlers: ["tls", "http"] }],
                checks: [
                  {
                    type: "http",
                    port: 3000,
                    path: "/health",
                    interval: "2s",
                    timeout: "1s",
                  },
                ],
                autostop: "off",
              },
            ],
            deploy: {
              strategy: "bluegreen",
              healthTimeout: badHealth ? "15 seconds" : "30 seconds",
            },
            shutdown: { signal: "SIGTERM", timeout: "10 seconds" },
          });
        }),
      );
  });

const request = (appName: string, route = "/") =>
  HttpClient.get(`https://${appName}.fly.dev${route}`, {
    headers: { connection: "close" },
  }).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.succeed(response)
        : Effect.fail(new Error(`Public HTTP ${response.status}`)),
    ),
    Effect.timeout("5 seconds"),
  );
const version = (appName: string) =>
  request(appName).pipe(
    Effect.flatMap((response) => response.text),
    Effect.timeout("5 seconds"),
  );
const sampleTraffic = (appName: string) =>
  Effect.gen(function* () {
    const samples = yield* Ref.make<string[]>([]);
    const finished = yield* Ref.make(false);
    const fiber = yield* Stream.range(0, 359).pipe(
      Stream.mapEffect(() =>
        version(appName).pipe(
          Effect.result,
          Effect.flatMap((result) =>
            Ref.update(samples, (values) => [
              ...values,
              Result.isSuccess(result) ? result.success : "HTTP failure",
            ]),
          ),
          Effect.andThen(Effect.sleep("250 millis")),
          Effect.andThen(Ref.get(finished)),
        ),
      ),
      Stream.takeUntil((done) => done),
      Stream.runDrain,
      Effect.forkScoped,
    );
    return Effect.gen(function* () {
      yield* Ref.set(finished, true);
      yield* Fiber.join(fiber);
      return yield* Ref.get(samples);
    });
  });
const appGone = (appName: string) =>
  machines.getApp({ app_name: appName }).pipe(
    Effect.as(false),
    Effect.catchTag("NotFound", () => Effect.succeed(true)),
  );

for (const badHealth of [false, true]) {
  const name = badHealth
    ? "unhealthy container candidates never receive public traffic"
    : "public replacement drains in-flight requests in both containers after SIGTERM";
  if (orgSlug === undefined) {
    test.skip(name, Effect.void);
    continue;
  }
  // Provision separately so rollout plus draining fits the per-test deadline.
  // Match test.provider's durable namespace so its finalizer also owns cleanup.
  const prepared = scratchStack(options, name, currentFile());
  const initial = beforeAll(
    Effect.gen(function* () {
      yield* prepared.destroy();
      const deploy = yield* scenario(prepared);
      const first = yield* deploy("old");
      expect(
        yield* version(first.appName).pipe(
          Effect.retry({ times: 8, schedule: Schedule.spaced("1 second") }),
        ),
      ).toBe("old");
      return { first, deploy };
    }),
    { timeout: 120_000 },
  );
  // Also runs when setup failed before test.provider could install its finalizer.
  afterAll(prepared.destroy(), { timeout: 120_000 });
  test.provider(
    name,
    (stack) =>
      Effect.gen(function* () {
        expect(stack.name).toBe(prepared.name);
        const { first, deploy } = yield* initial;
        const finishTraffic = yield* sampleTraffic(first.appName);
        if (badHealth) {
          const failed = yield* deploy("unready", true).pipe(Effect.result);
          expect(Result.isFailure(failed)).toBe(true);
          if (Result.isFailure(failed)) {
            expect(failed.failure).toBeInstanceOf(ReplicaChecksNotPassing);
            if (failed.failure instanceof ReplicaChecksNotPassing) {
              expect(failed.failure.machineId).not.toBe(first.machineId);
              expect(
                failed.failure.checks.some(
                  (check) =>
                    check.name === "sidecar" && check.status !== "passing",
                ),
              ).toBe(true);
            }
          }
          expect(yield* version(first.appName)).toBe("old");
          const samples = yield* finishTraffic;
          expect(samples.length).toBeGreaterThan(1);
          expect([...new Set(samples)]).toEqual(["old"]);
          const old = yield* machines.getMachine({
            app_name: first.appName,
            machine_id: first.machineId,
          });
          expect(old.state).toBe("started");
          expect(old.cordoned).toBe(false);
        } else {
          // Headers arrive only once the request is held inside each container.
          const web = yield* request(first.appName, "/hold");
          const sidecar = yield* request(first.appName, "/sidecar/hold");
          const webBody = yield* web.text.pipe(
            Effect.timeout("90 seconds"),
            Effect.forkScoped,
          );
          const sidecarBody = yield* sidecar.text.pipe(
            Effect.timeout("90 seconds"),
            Effect.forkScoped,
          );
          const second = yield* deploy("new");
          expect(second.machineId).not.toBe(first.machineId);
          for (const [name, body] of [
            ["web", yield* Fiber.join(webBody)],
            ["sidecar", yield* Fiber.join(sidecarBody)],
          ]) {
            expect(body).toBe(
              "waiting\n" +
                JSON.stringify({
                  machine: first.machineId,
                  name,
                  version: "old",
                  signal: "SIGTERM",
                }),
            );
          }
          expect(yield* version(first.appName)).toBe("new");
          // Include a post-cutover sample before joining the continuous probe.
          yield* Effect.sleep("500 millis");
          const samples = yield* finishTraffic;
          expect(samples).toContain("old");
          expect(samples).toContain("new");
          expect(
            samples.every((sample) => sample === "old" || sample === "new"),
          ).toBe(true);
          const oldGone = yield* machines
            .getMachine({
              app_name: first.appName,
              machine_id: first.machineId,
            })
            .pipe(
              Effect.map((machine) => machine.state === "destroyed"),
              Effect.catchTag("NotFound", () => Effect.succeed(true)),
            );
          expect(oldGone).toBe(true);
        }
        yield* stack.destroy();
        expect(yield* appGone(first.appName)).toBe(true);
      }),
    { timeout: 120_000 },
  );
}
