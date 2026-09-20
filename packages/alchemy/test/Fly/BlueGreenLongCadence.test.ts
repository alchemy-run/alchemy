import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import type { MachineProps } from "@/Fly/Machine";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import {
  assertReadinessCommit,
  readinessActor,
  readinessProxy,
} from "./fixtures/idle-cadence-readiness.ts";
import {
  assertAppGone,
  assertCommitted,
  census,
  checks,
  deployWorker,
} from "./fixtures/bluegreen.ts";

const file = "test/Fly/BlueGreenLongCadence.test.ts";
const { test } = Test.make({ providers: Fly.providers() });

const cadenceCheck = {
  ...checks.ready,
  path: "/cadence-ready",
  interval: "75s",
  gracePeriod: "0s",
};

describe.sequential("live long-cadence readiness and service interval limits", () => {
  for (const kind of ["named", "service"] as const) {
    for (const sufficient of [false, true]) {
      const budget = sufficient ? 120_000 : 35_000;
      const title = `S06 ${kind === "named" ? "named 75-second check interval" : "service 75-second interval capped by Fly to 60 seconds"} with zero grace ${sufficient ? "passes the next real report within a 120-second health budget" : "fails a 35-second budget without retiring predecessors"}`;
      test.provider(
        title,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const site = yield* stack.deploy(Fly.App("Site"));
            try {
              const first = yield* deployWorker(stack, "one");
              const proxy = yield* readinessProxy();
              const actor = yield* readinessActor(stack, title, file, proxy);
              const props: Partial<Omit<MachineProps, "app">> = {
                init: {
                  exec: [
                    "/bin/sh",
                    "-c",
                    "rm -f /usr/share/nginx/html/cadence-ready; (sleep 80; touch /usr/share/nginx/html/cadence-ready) & exec nginx -g 'daemon off;'",
                  ],
                },
                checks: kind === "named" ? { ready: cadenceCheck } : {},
                services:
                  kind === "service"
                    ? [
                        {
                          protocol: "tcp",
                          internalPort: 80,
                          autostop: "off",
                          checks: [cadenceCheck],
                        },
                      ]
                    : [],
                deploy: { strategy: "bluegreen", healthTimeout: budget },
              };
              yield* Effect.gen(function* () {
                const started = yield* Clock.currentTimeMillis;
                const attempt = yield* deployWorker(actor, "two", props).pipe(
                  Effect.scoped,
                  Effect.result,
                  Effect.forkScoped,
                );
                const checkName =
                  kind === "named" ? "ready" : "servicecheck-00-http-80";
                const failed = yield* census(site.appName).pipe(
                  Effect.map((live) =>
                    live.find(
                      (machine) =>
                        !first.machineIds.includes(machine.id!) &&
                        machine.state === "started" &&
                        machine.checks?.some(
                          (check) =>
                            check.name === checkName &&
                            check.status === "critical",
                        ),
                    ),
                  ),
                  Effect.repeat({
                    schedule: Schedule.spaced("1 second"),
                    times: 120,
                    until: (machine) => machine !== undefined,
                  }),
                  Effect.timeout("150 seconds"),
                  Effect.raceFirst(
                    Effect.gen(function* () {
                      const result = yield* Fiber.join(attempt);
                      if (Result.isFailure(result))
                        return yield* Effect.fail(result.failure);
                      return yield* Effect.fail(
                        new Error(
                          "Candidate committed before a failing long-cadence report was observed",
                        ),
                      );
                    }),
                  ),
                );
                expect(failed).toBeDefined();
                if (!failed)
                  return yield* Effect.fail(
                    new Error(
                      "Fly never emitted the initial failing cadence report",
                    ),
                  );
                const nativeCheck =
                  kind === "named"
                    ? failed.config?.checks?.ready
                    : failed.config?.services?.[0]?.checks?.[0];
                expect(
                  kind === "named" ? ["75s", "1m15s"] : ["60s", "1m0s", "1m"],
                ).toContain(nativeCheck?.interval);
                expect(["0s", "0", undefined]).toContain(
                  nativeCheck?.grace_period,
                );
                expect(failed.cordoned).toBe(true);
                const failureReport = failed.checks!.find(
                  (check) => check.name === checkName,
                )!;
                expect(failureReport.updated_at).toBeDefined();
                if (sufficient) {
                  const passing = yield* machines
                    .getMachine({
                      app_name: site.appName,
                      machine_id: failed.id!,
                    })
                    .pipe(
                      Effect.repeat({
                        schedule: Schedule.spaced("1 second"),
                        times: 120,
                        until: (machine) =>
                          machine.checks?.some(
                            (check) =>
                              check.name === checkName &&
                              check.status === "passing",
                          ) === true,
                      }),
                      Effect.timeout("120 seconds"),
                    );
                  const report = passing.checks?.find(
                    (check) => check.name === checkName,
                  );
                  expect(report?.status).toBe("passing");
                  expect(report?.updated_at).toBeDefined();
                  expect(failed.instance_id).toBeDefined();
                  expect(passing.instance_id).toBe(failed.instance_id);
                  const reportSpacing = yield* Effect.sync(
                    () =>
                      Date.parse(report!.updated_at!) -
                      Date.parse(failureReport.updated_at!),
                  );
                  expect(reportSpacing).toBeGreaterThan(60_000);
                  yield* Effect.logInfo(
                    "Native cadence reports across autonomous readiness transition",
                    {
                      reportSpacingMs: reportSpacing,
                      failingReport: failureReport.updated_at,
                      passingReport: report!.updated_at,
                    },
                  );
                  const result = yield* Fiber.join(attempt).pipe(
                    Effect.timeout("600 seconds"),
                  );
                  expect(Result.isSuccess(result)).toBe(true);
                  if (Result.isFailure(result))
                    return yield* Effect.fail(result.failure);
                  expect(result.success.machineIds).toEqual([failed.id]);
                  const committed = yield* assertCommitted(
                    site.appName,
                    result.success.machineIds,
                  );
                  expect(committed[0]!.instance_id).toBe(failed.instance_id);
                  assertReadinessCommit(
                    proxy.readiness,
                    first.machineIds,
                    committed,
                    [0],
                    [checkName],
                    false,
                  );
                } else {
                  const result = yield* Fiber.join(attempt).pipe(
                    Effect.timeout("180 seconds"),
                  );
                  expect(Result.isFailure(result)).toBe(true);
                  if (Result.isFailure(result))
                    expect(result.failure._tag).toBe(
                      "Fly.ReplicaChecksNotPassing",
                    );
                  expect(
                    (yield* Clock.currentTimeMillis) - started,
                  ).toBeLessThan(180_000);
                  const live = yield* census(site.appName);
                  expect(live.map((machine) => machine.id)).toEqual(
                    first.machineIds,
                  );
                  expect(live[0]!.state).toBe("started");
                  expect(live[0]!.cordoned).toBe(false);
                  expect(
                    proxy.events.some(
                      (event) =>
                        event.stage === "request" &&
                        first.machineIds.includes(event.machineId!) &&
                        (event.path.endsWith("/stop") ||
                          event.path.endsWith("/cordon") ||
                          event.path.endsWith("/suspend") ||
                          (event.path.endsWith("/metadata") &&
                            event.phase === "retiring") ||
                          (event.method === "DELETE" &&
                            /\/machines\/[^/]+$/.test(event.path))),
                    ),
                  ).toBe(false);
                  expect(
                    proxy.events.some(
                      (event) =>
                        event.machineId === failed.id &&
                        event.path.endsWith("/uncordon"),
                    ),
                  ).toBe(false);
                  expect(
                    proxy.readiness.some(
                      (event) =>
                        event.stage === "request" &&
                        event.machineId === failed.id &&
                        event.path.endsWith("/metadata") &&
                        event.phase === "active",
                    ),
                  ).toBe(false);
                }
                yield* Effect.logInfo("Live long-cadence evidence", {
                  kind,
                  interval: nativeCheck?.interval,
                  grace: nativeCheck?.grace_period,
                  budget,
                  firstFailure: failureReport.updated_at,
                  elapsedMs: (yield* Clock.currentTimeMillis) - started,
                });
              }).pipe(Effect.scoped);
            } finally {
              yield* stack.destroy();
              yield* assertAppGone(site.appName);
            }
          }).pipe(Effect.scoped),
        { timeout: 1_200_000 },
      );
    }
  }
});
