import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { randomBytes } from "node:crypto";
import { engineActor } from "./fixtures/actors.ts";
import { assertAppGone, census, checks } from "./fixtures/bluegreen.ts";
import {
  Site,
  Token,
  TRIGGER_SECRET,
  Writer,
  writerLayer,
} from "./fixtures/bluegreen-runtime-secrets/writer.ts";
import { transportProxy } from "./fixtures/transport.ts";

const { test } = Test.make({ providers: Fly.providers() });

class WriterProbeFailed extends Data.TaggedError("WriterProbeFailed")<{
  stage: "transport" | "status" | "decode";
  status?: number;
}> {}

const Receipt = Schema.Struct({
  version: Schema.Number,
  machineId: Schema.String,
  marker: Schema.Literals(["ready", "three"]),
});

const probeWriter = (
  appName: string,
  token: Redacted.Redacted<string>,
  method: "GET" | "POST",
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = `https://${appName}.fly.dev/writer`;
    const request = (
      method === "POST"
        ? HttpClientRequest.post(url)
        : HttpClientRequest.get(url)
    ).pipe(HttpClientRequest.bearerToken(token));
    const response = yield* client
      .execute(request)
      .pipe(
        Effect.mapError(() => new WriterProbeFailed({ stage: "transport" })),
      );
    if (response.status !== 200) {
      return yield* new WriterProbeFailed({
        stage: "status",
        status: response.status,
      });
    }
    return yield* response.json.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Receipt, { onExcessProperty: "error" }),
      ),
      Effect.mapError(() => new WriterProbeFailed({ stage: "decode" })),
    );
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new WriterProbeFailed({ stage: "transport" })),
    ),
  );

const marker = (appName: string, machineId: string) =>
  machines
    .execMachine({
      app_name: appName,
      machine_id: machineId,
      command: ["cat", "/usr/share/nginx/html/marker"],
      timeout: 5,
    })
    .pipe(
      Effect.map((response) => {
        const value = response.stdout?.trim();
        return {
          code: response.exit_code,
          marker: value === "two" || value === "three" ? value : "missing",
        };
      }),
    );

const title =
  "F12 deployed sibling runtime writer advances the shared vault during a held candidate create";

test.provider(
  title,
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const proxy = yield* transportProxy();
      let appName: string | undefined;
      yield* Effect.addFinalizer(() =>
        stack.destroy().pipe(
          Effect.andThen(() =>
            appName === undefined ? Effect.void : assertAppGone(appName),
          ),
          Effect.orDie,
        ),
      );
      const actor = yield* engineActor(
        stack,
        title,
        "test/Fly/BlueGreenRuntimeSecrets.test.ts",
        proxy.url,
      );
      const trigger = yield* Effect.sync(() =>
        Redacted.make(
          Array.from(randomBytes(32), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
        ),
      );
      const deploy = (count: number, floor?: number) =>
        actor.deploy(
          Effect.gen(function* () {
            const app = yield* Site;
            const secret = yield* Token;
            const auth = yield* Fly.Secret("WriterTrigger", {
              app,
              name: TRIGGER_SECRET,
              value: trigger,
            });
            yield* Fly.IpAssignment("Public", { app, type: "shared_v4" });
            const writer = yield* Writer.pipe(
              Effect.provide(writerLayer(auth.digest)),
            );
            const consumer = yield* Fly.Machine("Consumer", {
              app,
              region: "iad",
              image: "nginx:alpine",
              count,
              minSecretsVersion: floor,
              env: { SECRET_RESOURCE_NAME: secret.name },
              init: {
                exec: [
                  "/bin/sh",
                  "-c",
                  "case \"$ACCEPTANCE_RUNTIME_SECRET\" in *-two) marker=two;; *-three) marker=three;; *) marker=missing;; esac; printf '%s' \"$marker\" > /usr/share/nginx/html/marker; exec nginx -g 'daemon off;'",
                ],
              },
              checks,
              deploy: { strategy: "bluegreen", healthTimeout: "60 seconds" },
              shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
            });
            return { app, secret, writer, consumer };
          }),
        );

      const initial = yield* deploy(1);
      appName = initial.app.appName;
      expect(initial.writer.machineIds).toHaveLength(1);
      expect(initial.consumer.machineIds).toHaveLength(1);
      expect(initial.consumer.imageRef?.digest).toBeTruthy();
      expect(yield* marker(appName, initial.consumer.machineId)).toEqual({
        code: 0,
        marker: "two",
      });
      const before = yield* probeWriter(appName, trigger, "GET").pipe(
        Effect.retry({
          while: (error) =>
            error.stage === "transport" ||
            (error.stage === "status" &&
              [404, 502, 503].includes(error.status ?? 0)),
          schedule: Schedule.spaced("2 seconds"),
          times: 8,
        }),
        Effect.timeout("90 seconds"),
      );
      expect(before).toEqual({
        version: 0,
        machineId: initial.writer.machineId,
        marker: "ready",
      });
      const client = yield* HttpClient.HttpClient;
      const unauthorized = yield* client
        .post(`https://${appName}.fly.dev/writer`)
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError(() => new WriterProbeFailed({ stage: "transport" })),
        );
      expect(unauthorized.status).toBe(401);
      const initialCensus = yield* census(appName);
      expect(initialCensus.map((machine) => machine.id).sort()).toEqual(
        [...initial.writer.machineIds, ...initial.consumer.machineIds].sort(),
      );
      const writerBefore = initialCensus.find(
        (machine) => machine.id === initial.writer.machineId,
      );
      expect(writerBefore?.instance_id).toBeTruthy();
      expect(writerBefore?.image_ref?.digest).toBeTruthy();
      const secretWrites = proxy.events.filter(
        (event) =>
          event.stage === "completed" &&
          event.method === "POST" &&
          event.path.startsWith(`/v1/apps/${appName}/secrets`) &&
          event.status !== undefined &&
          event.status >= 200 &&
          event.status < 300 &&
          event.secretsVersion !== undefined,
      );
      expect(secretWrites.length).toBeGreaterThan(0);
      const floor = Math.max(
        ...secretWrites.map((event) => event.secretsVersion!),
      );
      expect(Number.isSafeInteger(floor)).toBe(true);
      expect(floor).toBeGreaterThan(0);
      const start = proxy.events.length;
      const machinePath = `/v1/apps/${appName}/machines`;
      yield* Effect.sync(() =>
        proxy.arm({
          match: (event) =>
            event.method === "POST" &&
            event.path === machinePath &&
            event.phase === "candidate",
          action: "hold-response",
          remaining: 1,
        }),
      );
      yield* Effect.gen(function* () {
        const rollout = yield* deploy(2, floor).pipe(
          Effect.scoped,
          Effect.forkScoped,
        );
        const held = yield* proxy.wait(
          (event) =>
            event.stage === "held" &&
            event.path === machinePath &&
            event.status !== undefined &&
            event.status >= 200 &&
            event.status < 300,
        );
        expect(held.machineId).toBeTruthy();
        expect(held.minSecretsVersion).toBe(floor);
        // This POST runs the existing WriteSecret binding inside the sibling Machine.
        const later = yield* probeWriter(initial.app.appName, trigger, "POST");
        expect(later.machineId).toBe(initial.writer.machineId);
        expect(later.marker).toBe("three");
        expect(Number.isSafeInteger(later.version)).toBe(true);
        expect(later.version).toBeGreaterThan(floor);
        expect(
          proxy.events.some(
            (event) =>
              event.sequence === held.sequence && event.stage === "forwarded",
          ),
        ).toBe(false);
        yield* Effect.sync(proxy.release);
        const next = yield* Fiber.join(rollout).pipe(
          Effect.timeout("240 seconds"),
        );
        expect(next.app.appName).toBe(initial.app.appName);
        expect(next.secret.name).toBe(initial.secret.name);
        expect(next.writer.machineIds).toEqual(initial.writer.machineIds);
        expect(next.consumer.machineIds).toHaveLength(2);
        expect(next.consumer.machineIds).toContain(held.machineId);
        expect(next.consumer.machineIds).not.toContain(
          initial.consumer.machineId,
        );
        const events = proxy.events.slice(start);
        const creates = events.filter(
          (event) =>
            event.stage === "request" &&
            event.method === "POST" &&
            event.path === machinePath,
        );
        expect(creates).toHaveLength(2);
        expect(creates[0]?.sequence).toBe(held.sequence);
        expect(
          creates.every((event) => event.minSecretsVersion === floor),
        ).toBe(true);
        const released = events.findIndex(
          (event) =>
            event.sequence === held.sequence && event.stage === "forwarded",
        );
        expect(released).toBeGreaterThan(-1);
        expect(events.indexOf(creates[1]!)).toBeGreaterThan(released);
        expect(
          events.some(
            (event) =>
              event.stage === "request" &&
              event.machineId === initial.writer.machineId &&
              event.method !== "GET",
          ),
        ).toBe(false);
        const live = yield* census(initial.app.appName);
        expect(live.map((machine) => machine.id).sort()).toEqual(
          [...next.writer.machineIds, ...next.consumer.machineIds].sort(),
        );
        const writerAfter = live.find(
          (machine) => machine.id === initial.writer.machineId,
        );
        expect(writerAfter?.instance_id).toBe(writerBefore?.instance_id);
        expect(writerAfter?.image_ref?.digest).toBe(
          writerBefore?.image_ref?.digest,
        );
        for (const id of next.consumer.machineIds) {
          const machine = live.find((machine) => machine.id === id);
          expect(machine?.config?.metadata?.["alchemy.phase"]).toBe("active");
          expect(machine?.image_ref?.digest).toBe(
            initial.consumer.imageRef?.digest,
          );
          const observed = yield* marker(initial.app.appName, id);
          expect(observed.code).toBe(0);
          expect(
            id === held.machineId ? ["two", "three"] : ["three"],
          ).toContain(observed.marker);
        }
        expect(yield* probeWriter(initial.app.appName, trigger, "GET")).toEqual(
          before,
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            proxy.clear();
            proxy.release();
          }),
        ),
        Effect.scoped,
      );
    }).pipe(Effect.scoped),
  { timeout: 900_000 },
);
