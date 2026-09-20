import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  assertAppGone,
  assertCommitted,
  checks,
} from "./fixtures/bluegreen.ts";
import { engineActor } from "./fixtures/actors.ts";
import { transportProxy } from "./fixtures/transport.ts";

const { test } = Test.make({ providers: Fly.providers() });

const tenTitle =
  "S01 F13 real 1-to-10-to-10-to-1 generations pin one digest and check every candidate before routing or old retirement";
test.provider(
  tenTitle,
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const proxy = yield* transportProxy();
      const actor = yield* engineActor(
        stack,
        tenTitle,
        "test/Fly/BlueGreenScaling.test.ts",
        proxy.url,
      );
      const services = [
        {
          protocol: "tcp" as const,
          internalPort: 80,
          autostop: "off" as const,
          ports: [{ port: 80, handlers: ["http" as const] }],
          checks: [
            {
              type: "http" as const,
              port: 80,
              path: "/",
              interval: "2s",
              timeout: "1s",
            },
          ],
        },
      ];
      const deploy = (version: string, count: number) =>
        actor.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("Site");
            yield* Fly.IpAssignment("Public", { app, type: "shared_v4" });
            return yield* Fly.Machine("Worker", {
              app,
              image: "nginx:alpine",
              count,
              services,
              checks,
              env: { VERSION: version },
              init: {
                exec: [
                  "/bin/sh",
                  "-c",
                  "printf '%s:%s' \"$VERSION\" \"$FLY_MACHINE_ID\" > /usr/share/nginx/html/version; exec nginx -g 'daemon off;'",
                ],
              },
              deploy: { strategy: "bluegreen", healthTimeout: "60 seconds" },
              shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
            });
          }),
        );
      const client = yield* HttpClient.HttpClient;
      const traffic = (appName: string) =>
        client.get(`http://${appName}.fly.dev/version`).pipe(
          Effect.flatMap((response) => {
            expect(response.status).toBe(200);
            return response.text;
          }),
        );
      let previous = yield* deploy("one", 1);
      expect(
        yield* traffic(previous.appName).pipe(
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 8 }),
        ),
      ).toBe(`one:${previous.machineId}`);
      for (const [version, count] of [
        ["two", 10],
        ["three", 10],
        ["four", 1],
      ] as const) {
        const start = proxy.events.length;
        const next = yield* deploy(version, count);
        const events = proxy.events.slice(start);
        const live = yield* assertCommitted(next.appName, next.machineIds);
        expect(live).toHaveLength(count);
        expect(
          new Set(
            live.map(
              (machine) => machine.config?.metadata?.["alchemy.generation"],
            ),
          ).size,
        ).toBe(1);
        expect(
          new Set(
            live.map(
              (machine) => machine.config?.metadata?.["alchemy.replica"],
            ),
          ).size,
        ).toBe(count);
        expect(
          live.every(
            (machine) =>
              machine.config?.metadata?.["alchemy.count"] === String(count) &&
              machine.config?.env?.VERSION === version,
          ),
        ).toBe(true);
        expect(
          next.machineIds.every((id) => !previous.machineIds.includes(id)),
        ).toBe(true);
        const creates = events.filter(
          (event) =>
            event.stage === "completed" &&
            event.method === "POST" &&
            event.path.endsWith("/machines") &&
            event.status! < 300,
        );
        expect(creates).toHaveLength(count);
        const digest = creates[0]!.digest;
        expect(digest).toMatch(/^sha256:/);
        expect(
          live.every((machine) => machine.image_ref?.digest === digest),
        ).toBe(true);
        expect(
          creates
            .slice(1)
            .every((event) => event.image?.endsWith(`@${digest}`)),
        ).toBe(true);
        const firstRouting = events.findIndex(
          (event) =>
            event.stage === "request" && event.path.endsWith("/uncordon"),
        );
        expect(firstRouting).toBeGreaterThan(0);
        const beforeRouting = events.slice(0, firstRouting);
        for (const id of next.machineIds) {
          const reads = beforeRouting.filter(
            (event) =>
              event.stage === "completed" &&
              event.method === "GET" &&
              event.path.endsWith(`/machines/${id}`) &&
              event.status === 200,
          );
          const ready = reads.at(-1);
          const lastConfigWrite = beforeRouting.findLastIndex(
            (event) =>
              event.stage === "completed" &&
              event.machineId === id &&
              event.status! < 300 &&
              event.method !== "GET" &&
              !event.path.endsWith("/lease"),
          );
          expect(ready).toBeDefined();
          expect(beforeRouting.indexOf(ready!)).toBeGreaterThan(
            lastConfigWrite,
          );
          expect(ready?.state).toBe("started");
          expect(ready?.cordoned).toBe(true);
          expect(ready?.instanceId).toBeDefined();
          expect(ready?.digest).toBe(digest);
          expect(
            ready?.checks?.find((check) => check.name === "ready")?.status,
          ).toBe("passing");
          expect(
            ready?.checks?.some((check) =>
              check.name?.startsWith("servicecheck-"),
            ),
          ).toBe(true);
          expect(
            ready?.checks?.every((check) => check.status === "passing"),
          ).toBe(true);
        }
        expect(
          beforeRouting.some(
            (event) =>
              event.stage === "request" &&
              previous.machineIds.includes(event.machineId ?? "") &&
              (event.path.endsWith("/stop") ||
                event.path.endsWith("/cordon") ||
                event.method === "DELETE") &&
              !event.path.endsWith("/lease"),
          ),
        ).toBe(false);
        const served = yield* traffic(next.appName);
        expect(next.machineIds.map((id) => `${version}:${id}`)).toContain(
          served,
        );
        previous = next;
      }
      yield* stack.destroy();
      yield* assertAppGone(previous.appName);
    }).pipe(Effect.scoped),
  { timeout: 900_000 },
);

for (const [before, after] of [
  [1, 2],
  [2, 1],
] as const) {
  test.provider(
    `F13 ${before === 2 ? "F14 " : ""}replaces the complete replica set when scaling from ${before} to ${after}`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const deploy = (count: number, strategy: "rolling" | "bluegreen") =>
          stack.deploy(
            Effect.gen(function* () {
              const app = yield* Fly.App("Site");
              return yield* Fly.Machine("Worker", {
                app,
                name: "scaling-worker",
                image: "nginx:alpine",
                count,
                deploy: { strategy, healthTimeout: "30 seconds" },
                shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
                checks: {
                  ready: {
                    type: "http",
                    port: 80,
                    path: "/",
                    interval: "2s",
                    timeout: "1s",
                  },
                },
              });
            }),
          );
        const initial = yield* deploy(
          before,
          before === 2 ? "rolling" : "bluegreen",
        );
        if (before === 2) {
          // Reproduce the ownership metadata written before generation support.
          for (const machineId of initial.machineIds) {
            for (const key of [
              "alchemy.instance",
              "alchemy.fqn",
              "alchemy.base-name",
            ]) {
              yield* machines.deleteMachineMetadata({
                app_name: initial.appName,
                machine_id: machineId,
                key,
              });
            }
          }
          const legacy = yield* machines
            .listMachines({ app_name: initial.appName })
            .pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: (listed) =>
                  listed.every(
                    (machine) =>
                      machine.config?.metadata?.["alchemy.instance"] ===
                      undefined,
                  ),
                times: 8,
              }),
            );
          expect(
            legacy.every(
              (machine) =>
                machine.config?.metadata?.["alchemy.instance"] === undefined,
            ),
          ).toBe(true);
        }
        const scaled = yield* deploy(after, "bluegreen");
        expect(scaled.count).toBe(after);
        expect(scaled.machineIds).toHaveLength(after);
        expect(
          scaled.machineIds.every((id) => !initial.machineIds.includes(id)),
        ).toBe(true);
        const live = (yield* machines.listMachines({
          app_name: initial.appName,
        })).filter((machine) => machine.state !== "destroyed");
        expect(live).toHaveLength(after);
        expect(
          live.every(
            (machine) =>
              machine.cordoned === false &&
              machine.config?.metadata?.["alchemy.phase"] === "active",
          ),
        ).toBe(true);
        expect(
          new Set(live.map((machine) => machine.image_ref?.digest)).size,
        ).toBe(1);
        yield* stack.destroy();
        yield* assertAppGone(initial.appName);
      }),
    { timeout: 300_000 },
  );
}
