import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import {
  autostopMode,
  checksPassing,
  ensureStarted,
  waitHealthy,
} from "@/Fly/replicas";
import * as Test from "@/Test/Alchemy";
import { readinessRoles } from "@/Fly/bluegreen";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

const { test } = Test.make({ providers: Fly.providers() });

it.effect(
  "S03 check identity rejects duplicate, missing, warning and unknown reports",
  () =>
    Effect.sync(() => {
      const config = {
        checks: { ready: { type: "http", port: 80 } },
        services: [{ internal_port: 80, checks: [{ type: "http" }] }],
      };
      const checks = [
        { name: "ready", status: "passing" },
        { name: "servicecheck-00-http-80", status: "passing" },
      ];
      expect(checksPassing({ state: "started", checks }, config)).toBe(true);
      expect(checksPassing({ state: "stopped", checks }, config)).toBe(false);
      for (const invalid of [
        [],
        checks.slice(0, 1),
        [checks[0]!, checks[0]!],
        [...checks, { name: "unknown", status: "passing" }],
        checks.map((check) => ({ ...check, status: "warning" })),
      ]) {
        expect(
          checksPassing({ state: "started", checks: invalid }, config),
        ).toBe(false);
      }
    }),
);

it.effect(
  "S05 deterministic representatives, floors, scale-up and mixed-service roles",
  () =>
    Effect.sync(() => {
      const services = [{ autostop: "stop", min_machines_running: 0 }];
      expect(readinessRoles({ services }, 3, [])).toEqual([
        "run",
        "idle",
        "idle",
      ]);
      const running = [
        { state: "started", config: { metadata: { "alchemy.replica": "1" } } },
      ];
      expect(readinessRoles({ services }, 3, running)).toEqual([
        "idle",
        "run",
        "idle",
      ]);
      expect(
        readinessRoles(
          { services: [{ autostop: "suspend", min_machines_running: 2 }] },
          3,
          running,
        ),
      ).toEqual(["run", "run", "idle"]);
      expect(
        readinessRoles({ services: [...services, { autostop: "off" }] }, 3, []),
      ).toEqual(["run", "run", "run"]);
    }),
);

for (const autostop of ["stop", "suspend"] as const) {
  test.provider(
    `S05 S11 ${autostop} all-idle replacement preserves nonrepresentatives`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const deploy = (version: string, healthTimeout = 20_000) =>
          stack.deploy(
            Effect.gen(function* () {
              const app = yield* Fly.App("Site");
              return yield* Fly.Machine("Worker", {
                app,
                image: "nginx:alpine",
                count: 2,
                env: { VERSION: version },
                deploy: { strategy: "bluegreen", healthTimeout },
                shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
                services: [
                  {
                    protocol: "tcp",
                    internalPort: 80,
                    autostop,
                    autostart: true,
                    minMachinesRunning: 0,
                    checks: [
                      {
                        type: "http",
                        port: 80,
                        path: "/",
                        interval: "2s",
                        timeout: "1s",
                      },
                    ],
                  },
                ],
              });
            }),
          );
        const first = yield* deploy("one");
        const firstIdle = yield* machines.getMachine({
          app_name: first.appName,
          machine_id: first.machineIds[1]!,
        });
        expect(firstIdle.config?.metadata?.["alchemy.readiness-role"]).toBe(
          "idle",
        );
        expect(firstIdle.state).not.toBe("started");
        const primary = {
          app_name: first.appName,
          machine_id: first.machineId,
        };
        if (autostop === "suspend") yield* machines.suspendMachine(primary);
        else
          yield* machines.stopMachine({
            ...primary,
            signal: "SIGQUIT",
            timeout: "10s",
          });
        yield* machines.waitMachine({
          ...primary,
          state: autostop === "suspend" ? "suspended" : "stopped",
          timeout: 8,
        });
        const second = yield* deploy("two");
        expect(
          second.machineIds.every((id) => !first.machineIds.includes(id)),
        ).toBe(true);
        const live = (yield* machines.listMachines({
          app_name: second.appName,
        })).filter((machine) => machine.state !== "destroyed");
        expect(live.map((machine) => machine.id).sort()).toEqual(
          [...second.machineIds].sort(),
        );
        const nonrepresentative = live.find(
          (machine) => machine.config?.metadata?.["alchemy.replica"] === "1",
        );
        expect(nonrepresentative?.state).not.toBe("started");
        expect(nonrepresentative?.config?.metadata?.["alchemy.phase"]).toBe(
          "active",
        );
        expect(
          autostopMode(nonrepresentative?.config?.services?.[0]?.autostop),
        ).toBe(autostop);
        const committed = {
          app_name: second.appName,
          machine_id: second.machineId,
        };
        if (autostop === "suspend") yield* machines.suspendMachine(committed);
        else
          yield* machines.stopMachine({
            ...committed,
            signal: "SIGQUIT",
            timeout: "10s",
          });
        yield* machines.waitMachine({
          ...committed,
          state: autostop === "suspend" ? "suspended" : "stopped",
          timeout: 8,
        });
        const unchanged = yield* deploy("two", 22_000);
        expect(unchanged.machineIds).toEqual(second.machineIds);
        expect((yield* machines.getMachine(committed)).state).not.toBe(
          "started",
        );
        yield* stack.destroy();
        expect(
          yield* machines.listMachines({ app_name: second.appName }).pipe(
            Effect.map((machines) =>
              machines.filter((machine) => machine.state !== "destroyed"),
            ),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          ),
        ).toEqual([]);
      }),
    { timeout: 120_000 },
  );
}

for (const autostop of ["stop", "suspend"] as const) {
  test.provider(
    `P3 ${autostop} cordoned readiness and restored instance probe`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const output = yield* stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("Site");
            return yield* Fly.Machine("Worker", {
              app,
              image: "nginx:alpine",
              skipLaunch: true,
              services: [
                {
                  protocol: "tcp",
                  internalPort: 80,
                  autostop,
                  autostart: true,
                  minMachinesRunning: 0,
                  ports: [{ port: 80, handlers: ["http"] }],
                  checks: [
                    {
                      type: "http",
                      port: 80,
                      path: "/",
                      interval: "2s",
                      timeout: "1s",
                    },
                    { type: "tcp", port: 80, interval: "2s", timeout: "1s" },
                  ],
                },
                {
                  protocol: "tcp",
                  internalPort: 81,
                  autostop,
                  autostart: true,
                  checks: [
                    {
                      type: "http",
                      port: 80,
                      path: "/",
                      interval: "2s",
                      timeout: "1s",
                    },
                  ],
                },
              ],
            });
          }),
        );
        const request = {
          app_name: output.appName,
          machine_id: output.machineId,
        };
        const original = yield* machines.getMachine(request);
        yield* machines.cordonMachine(request);
        const prepared = yield* machines.updateMachine({
          ...request,
          config: {
            ...original.config,
            services: original.config?.services?.map((service) => ({
              ...service,
              autostop: "off",
            })),
          },
          skip_launch: true,
          skip_service_registration: true,
        });
        const ready = yield* ensureStarted(
          output.appName,
          prepared,
          false,
          30_000,
        );
        expect(ready.cordoned).toBe(true);
        yield* machines.uncordonMachine(request);
        const restored = yield* machines.updateMachine({
          ...request,
          config: original.config,
        });
        const fresh = yield* ensureStarted(
          output.appName,
          restored,
          false,
          30_000,
        );
        yield* waitHealthy(output.appName, fresh, 30_000);
        yield* Effect.logInfo("P3 restored idle policy", {
          autostop,
          beforeInstance: ready.instance_id,
          afterInstance: fresh.instance_id,
          state: fresh.state,
          checks: fresh.checks?.map((check) => ({
            name: check.name,
            status: check.status,
          })),
        });
        expect(autostopMode(fresh.config?.services?.[0]?.autostop)).toBe(
          autostop,
        );
        if (autostop === "suspend") yield* machines.suspendMachine(request);
        else
          yield* machines.stopMachine({
            ...request,
            signal: "SIGQUIT",
            timeout: "10s",
          });
        yield* machines.waitMachine({
          ...request,
          state: autostop === "suspend" ? "suspended" : "stopped",
          timeout: 8,
        });
        const idle = yield* machines.getMachine(request);
        expect(idle.state).toBe(
          autostop === "suspend" ? "suspended" : "stopped",
        );
        yield* stack.destroy();
        expect(
          yield* machines.getMachine(request).pipe(
            Effect.map((machine) => machine.state === "destroyed"),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
          ),
        ).toBe(true);
      }),
    { timeout: 120_000 },
  );
}

for (const autostop of ["stop", "suspend"] as const) {
  test.provider(
    `P3 public ${autostop} restored policy autostarts on real traffic`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const output = yield* stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("Site");
            yield* Fly.IpAssignment("Public", { app, type: "shared_v4" });
            return yield* Fly.Machine("Worker", {
              app,
              image: "nginx:alpine",
              deploy: { strategy: "bluegreen", healthTimeout: "20 seconds" },
              shutdown: { signal: "SIGQUIT", timeout: "10 seconds" },
              services: [
                {
                  protocol: "tcp",
                  internalPort: 80,
                  autostop,
                  autostart: true,
                  minMachinesRunning: 0,
                  ports: [{ port: 80, handlers: ["http"] }],
                  checks: [
                    {
                      type: "http",
                      port: 80,
                      path: "/",
                      interval: "2s",
                      timeout: "1s",
                    },
                  ],
                },
              ],
            });
          }),
        );
        const request = {
          app_name: output.appName,
          machine_id: output.machineId,
        };
        if (autostop === "suspend") yield* machines.suspendMachine(request);
        else
          yield* machines.stopMachine({
            ...request,
            signal: "SIGQUIT",
            timeout: "10s",
          });
        yield* machines.waitMachine({
          ...request,
          state: autostop === "suspend" ? "suspended" : "stopped",
          timeout: 8,
        });
        const client = yield* HttpClient.HttpClient;
        const response = yield* client
          .get(`http://${output.appName}.fly.dev`)
          .pipe(
            Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 8 }),
          );
        expect(response.status).toBe(200);
        expect(yield* response.text).toContain("Welcome to nginx");
        const awakened = yield* machines.getMachine(request);
        expect(awakened.state).toBe("started");
        expect(autostopMode(awakened.config?.services?.[0]?.autostop)).toBe(
          autostop,
        );
        yield* stack.destroy();
        expect(
          yield* machines.getMachine(request).pipe(
            Effect.map((machine) => machine.state === "destroyed"),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
          ),
        ).toBe(true);
      }),
    { timeout: 120_000 },
  );
}
