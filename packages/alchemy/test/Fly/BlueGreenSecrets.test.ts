import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { engineActor } from "./fixtures/actors.ts";
import { transportProxy } from "./fixtures/transport.ts";
import {
  BoundSecrets,
  CacheOne,
  CacheTwo,
  Site,
} from "./fixtures/bluegreen-secrets.ts";
import {
  assertAppGone,
  assertCommitted,
  census,
  checks,
  deployWorker,
} from "./fixtures/bluegreen.ts";

const { test } = Test.make({ providers: Fly.providers() });

const marker = (appName: string, machineId: string) =>
  machines
    .execMachine({
      app_name: appName,
      machine_id: machineId,
      command: ["cat", "/usr/share/nginx/html/marker"],
      timeout: 5,
    })
    .pipe(
      Effect.map((response) => ({
        code: response.exit_code,
        marker: response.stdout?.trim(),
      })),
    );
const init = {
  exec: [
    "/bin/sh",
    "-c",
    "case \"$ACCEPTANCE_SECRET\" in *-one) marker=one;; *-two) marker=two;; *-three) marker=three;; *) marker=missing;; esac; printf '%s' \"$marker\" > /usr/share/nginx/html/marker; exec nginx -g 'daemon off;'",
  ],
};

test.provider(
  "F12 staged standalone rotation requires an explicit floor and later vault versions satisfy that floor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(Fly.App("Site"));
      const firstSecret = yield* machines.updateSecrets({
        app_name: app.appName,
        values: { ACCEPTANCE_SECRET: "fixture-token-one" },
      });
      const firstFloor = firstSecret.version ?? firstSecret.Version;
      expect(firstFloor).toBeGreaterThan(0);
      const first = yield* deployWorker(stack, "same-image", {
        init,
        minSecretsVersion: firstFloor,
      });
      expect(yield* marker(app.appName, first.machineId)).toEqual({
        code: 0,
        marker: "one",
      });
      const rotated = yield* machines.updateSecrets({
        app_name: app.appName,
        values: { ACCEPTANCE_SECRET: "fixture-token-two" },
      });
      const floor = rotated.version ?? rotated.Version;
      expect(floor).toBeGreaterThan(firstFloor!);
      const unchanged = yield* deployWorker(stack, "same-image", {
        init,
        minSecretsVersion: firstFloor,
      });
      expect(unchanged.machineIds).toEqual(first.machineIds);
      expect(yield* marker(app.appName, first.machineId)).toEqual({
        code: 0,
        marker: "one",
      });
      // A later writer advances the shared vault; the requested version is a floor, not a snapshot.
      const later = yield* machines.updateSecrets({
        app_name: app.appName,
        values: { ACCEPTANCE_SECRET: "fixture-token-three" },
      });
      expect(later.version ?? later.Version).toBeGreaterThan(floor!);
      const next = yield* deployWorker(stack, "same-image", {
        init,
        minSecretsVersion: floor,
      });
      expect(next.machineId).not.toBe(first.machineId);
      expect(yield* marker(app.appName, next.machineId)).toEqual({
        code: 0,
        marker: "three",
      });
      yield* assertCommitted(app.appName, next.machineIds);
      yield* stack.destroy();
      yield* assertAppGone(app.appName);
    }),
  { timeout: 300_000 },
);

const boundTitle =
  "F12 bound Config and real Redis attachment rotate before every replacement candidate";
test.provider(
  boundTitle,
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const proxy = yield* transportProxy();
      const actor = yield* engineActor(
        stack,
        boundTitle,
        "test/Fly/BlueGreenSecrets.test.ts",
        proxy.url,
      );
      const ambient = yield* ConfigProvider.ConfigProvider;
      const deploy = (version: "one" | "two", cache: "one" | "two") =>
        actor
          .deploy(
            Effect.gen(function* () {
              const app = yield* Site;
              const one = yield* CacheOne;
              const two = yield* CacheTwo;
              yield* Fly.IpAssignment("Public", { app, type: "shared_v4" });
              const service = yield* BoundSecrets;
              return { app, one, two, service };
            }),
          )
          .pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.orElse(
                ConfigProvider.fromUnknown({
                  ACCEPTANCE_BOUND_SECRET: `fixture-token-${version}`,
                  ACCEPTANCE_CACHE: cache,
                }),
                ambient,
              ),
            ),
          );
      const client = yield* HttpClient.HttpClient;
      const request = (appName: string, path: string) =>
        client.get(`http://${appName}.fly.dev${path}`).pipe(
          Effect.flatMap((response) => {
            expect(response.status).toBe(200);
            return response.json;
          }),
        );
      const initial = yield* deploy("one", "one");
      expect(
        yield* request(initial.app.appName, "/seed").pipe(
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 8 }),
        ),
      ).toEqual({ config: "one", redis: "one" });
      const configOnly = yield* deploy("two", "one");
      expect(
        configOnly.service.machineIds.every(
          (id) => !initial.service.machineIds.includes(id),
        ),
      ).toBe(true);
      expect(yield* request(initial.app.appName, "/marker")).toEqual({
        config: "two",
        redis: "one",
      });
      const start = proxy.events.length;
      const next = yield* deploy("two", "two");
      expect(next.one.redisId).toBe(initial.one.redisId);
      expect(next.two.redisId).toBe(initial.two.redisId);
      expect(
        next.service.machineIds.every(
          (id) => !configOnly.service.machineIds.includes(id),
        ),
      ).toBe(true);
      expect(yield* request(next.app.appName, "/marker")).toEqual({
        config: "two",
        redis: "empty",
      });
      expect(yield* request(next.app.appName, "/seed")).toEqual({
        config: "two",
        redis: "two",
      });
      const events = proxy.events.slice(start);
      const secretWrites = events.filter(
        (event) =>
          event.stage === "completed" &&
          event.method !== "GET" &&
          event.path.endsWith("/secrets") &&
          event.secretsVersion !== undefined,
      );
      expect(secretWrites.length).toBeGreaterThan(0);
      const floor = Math.max(
        ...secretWrites.map((event) => event.secretsVersion!),
      );
      const creates = events.filter(
        (event) =>
          event.stage === "request" &&
          event.method === "POST" &&
          event.path.endsWith("/machines"),
      );
      expect(creates).toHaveLength(2);
      expect(
        creates.every(
          (event) =>
            secretWrites.every(
              (write) => events.indexOf(write) < events.indexOf(event),
            ) &&
            event.minSecretsVersion !== undefined &&
            event.minSecretsVersion >= floor,
        ),
      ).toBe(true);
      const live = yield* assertCommitted(
        next.app.appName,
        next.service.machineIds,
      );
      expect(
        live.every(
          (machine) =>
            machine.image_ref?.digest === initial.service.imageRef?.digest,
        ),
      ).toBe(true);
      yield* stack.destroy();
      yield* assertAppGone(next.app.appName);
      expect(
        yield* Fly.findRedisAddOn({
          id: next.one.redisId,
          name: next.one.name,
        }),
      ).toBeUndefined();
      expect(
        yield* Fly.findRedisAddOn({
          id: next.two.redisId,
          name: next.two.name,
        }),
      ).toBeUndefined();
    }).pipe(Effect.scoped),
  { timeout: 600_000 },
);

const resourceTitle =
  "F12 Fly.Secret resource rotation is staged until an explicit Machine floor rollout";
test.provider(
  resourceTitle,
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (value: "one" | "two", floor?: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("Site");
            const secret = yield* Fly.Secret("Token", {
              app,
              name: "ACCEPTANCE_SECRET",
              value: Redacted.make(`fixture-token-${value}`),
            });
            const worker = yield* Fly.Machine("Worker", {
              app,
              image: "nginx:alpine",
              init,
              checks,
              minSecretsVersion: floor,
              env: { SECRET_RESOURCE_NAME: secret.name },
              deploy: { strategy: "bluegreen", healthTimeout: "30 seconds" },
              shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
            });
            return { app, secret, worker };
          }),
        );
      const initial = yield* deploy("one");
      expect(
        yield* marker(initial.app.appName, initial.worker.machineId),
      ).toEqual({ code: 0, marker: "one" });
      const staged = yield* deploy("two");
      expect(staged.secret.name).toBe(initial.secret.name);
      expect(staged.secret.digest).not.toBe(initial.secret.digest);
      expect(staged.worker.machineIds).toEqual(initial.worker.machineIds);
      expect(
        yield* marker(staged.app.appName, staged.worker.machineId),
      ).toEqual({ code: 0, marker: "one" });
      // A separate vault fence returns a floor that includes the completed Secret reconcile.
      const fence = yield* machines.updateSecrets({
        app_name: staged.app.appName,
        values: { ACCEPTANCE_FENCE: "two" },
      });
      const floor = fence.version ?? fence.Version;
      expect(floor).toBeGreaterThan(0);
      const next = yield* deploy("two", floor);
      expect(next.worker.machineId).not.toBe(initial.worker.machineId);
      expect(yield* marker(next.app.appName, next.worker.machineId)).toEqual({
        code: 0,
        marker: "two",
      });
      const live = yield* assertCommitted(
        next.app.appName,
        next.worker.machineIds,
      );
      expect(live[0]?.image_ref?.digest).toBe(initial.worker.imageRef?.digest);
      yield* stack.destroy();
      yield* assertAppGone(next.app.appName);
    }),
  { timeout: 600_000 },
);

const concurrentTitle =
  "F12 a real concurrent vault writer advances the floor while the first candidate response is held";
test.provider(
  concurrentTitle,
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(Fly.App("Site"));
      const firstSecret = yield* machines.updateSecrets({
        app_name: app.appName,
        values: { ACCEPTANCE_SECRET: "fixture-token-one" },
      });
      const initial = yield* deployWorker(stack, "same-image", {
        init,
        minSecretsVersion: firstSecret.version ?? firstSecret.Version,
      });
      const rotated = yield* machines.updateSecrets({
        app_name: app.appName,
        values: { ACCEPTANCE_SECRET: "fixture-token-two" },
      });
      const floor = rotated.version ?? rotated.Version;
      expect(floor).toBeGreaterThan(0);
      const proxy = yield* transportProxy();
      yield* Effect.sync(() =>
        proxy.arm({
          match: (event) =>
            event.method === "POST" && event.path.endsWith("/machines"),
          action: "hold-response",
          remaining: 1,
        }),
      );
      yield* Effect.gen(function* () {
        const actor = yield* engineActor(
          stack,
          concurrentTitle,
          "test/Fly/BlueGreenSecrets.test.ts",
          proxy.url,
        );
        const rollout = yield* deployWorker(actor, "same-image", {
          count: 2,
          init,
          minSecretsVersion: floor,
        }).pipe(Effect.scoped, Effect.forkScoped);
        const held = yield* proxy.wait(
          (event) => event.stage === "held" && event.status! < 300,
        );
        const writer = yield* machines
          .updateSecrets({
            app_name: app.appName,
            values: { ACCEPTANCE_SECRET: "fixture-token-three" },
          })
          .pipe(Effect.forkScoped);
        const later = yield* Fiber.join(writer);
        expect(later.version ?? later.Version).toBeGreaterThan(floor!);
        yield* Effect.sync(proxy.release);
        const next = yield* Fiber.join(rollout).pipe(
          Effect.timeout("180 seconds"),
        );
        const live = yield* assertCommitted(app.appName, next.machineIds);
        expect(next.machineIds).toContain(held.machineId);
        expect(next.machineIds).not.toContain(initial.machineId);
        const creates = proxy.events.filter(
          (event) =>
            event.stage === "request" &&
            event.method === "POST" &&
            event.path.endsWith("/machines"),
        );
        expect(creates).toHaveLength(2);
        expect(
          creates.every((event) => event.minSecretsVersion === floor),
        ).toBe(true);
        for (const machine of live) {
          const observed = yield* marker(app.appName, machine.id!);
          expect(observed.code).toBe(0);
          expect(
            machine.id === held.machineId ? ["two", "three"] : ["three"],
          ).toContain(observed.marker);
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            proxy.clear();
            proxy.release();
          }),
        ),
        Effect.scoped,
      );
      yield* stack.destroy();
      yield* assertAppGone(app.appName);
    }).pipe(Effect.scoped),
  { timeout: 600_000 },
);

const recoveryTitle =
  "F12 interrupted promoted candidate cannot satisfy a newer explicit secret floor";
test.provider(
  recoveryTitle,
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(Fly.App("Site"));
      const firstSecret = yield* machines.updateSecrets({
        app_name: app.appName,
        values: { ACCEPTANCE_SECRET: "fixture-token-one" },
      });
      yield* deployWorker(stack, "one", {
        init,
        minSecretsVersion: firstSecret.version ?? firstSecret.Version,
      });
      const rotated = yield* machines.updateSecrets({
        app_name: app.appName,
        values: { ACCEPTANCE_SECRET: "fixture-token-two" },
      });
      const floor = rotated.version ?? rotated.Version;
      const proxy = yield* transportProxy();
      yield* Effect.sync(() =>
        proxy.arm({
          match: (event) => event.path.endsWith("/uncordon"),
          action: "hold-response",
          remaining: 1,
        }),
      );
      yield* Effect.gen(function* () {
        const actor = yield* engineActor(
          stack,
          recoveryTitle,
          "test/Fly/BlueGreenSecrets.test.ts",
          proxy.url,
        );
        const rollout = yield* deployWorker(actor, "two", {
          init,
          minSecretsVersion: floor,
        }).pipe(Effect.scoped, Effect.forkScoped);
        const held = yield* proxy.wait(
          (event) => event.stage === "held" && event.status! < 300,
        );
        const interruption = yield* Fiber.interrupt(rollout).pipe(
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* Effect.sync(() => {
          proxy.clear();
          proxy.release();
        });
        yield* Fiber.join(interruption).pipe(Effect.timeout("120 seconds"));
        expect(Exit.hasInterrupts(yield* Fiber.await(rollout))).toBe(true);
        expect(
          (yield* census(app.appName)).some(
            (machine) => machine.id === held.machineId,
          ),
        ).toBe(true);
        const later = yield* machines.updateSecrets({
          app_name: app.appName,
          values: { ACCEPTANCE_SECRET: "fixture-token-three" },
        });
        const nextFloor = later.version ?? later.Version;
        expect(nextFloor).toBeGreaterThan(floor!);
        const resumed = yield* engineActor(
          stack,
          recoveryTitle,
          "test/Fly/BlueGreenSecrets.test.ts",
        );
        const next = yield* deployWorker(resumed, "two", {
          init,
          minSecretsVersion: nextFloor,
        });
        expect(next.machineIds).not.toContain(held.machineId);
        expect(yield* marker(app.appName, next.machineId)).toEqual({
          code: 0,
          marker: "three",
        });
        yield* assertCommitted(app.appName, next.machineIds);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            proxy.clear();
            proxy.release();
          }),
        ),
        Effect.scoped,
      );
      yield* stack.destroy();
      yield* assertAppGone(app.appName);
    }).pipe(Effect.scoped),
  { timeout: 600_000 },
);
