import {
  GatewayTimeout,
  HTTP_STATUS_MAP,
  RETRYABLE_HTTP_STATUSES,
} from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/fly-io/Credentials";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { dropCompletedCreate } from "./fixtures/bluegreen-create-proxy.ts";

const { test } = Test.make({ providers: Fly.providers() });

type Target = { app_name: string; machine_id: string };

// Transport failures can retain authorization and lease headers.
const sanitizeFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError(
      (error) =>
        new Error(error instanceof Error ? error.name : "Fly SDK probe failed"),
    ),
  );

test(
  "pure lease cleanup fails before successful-body teardown and keeps diagnostics private",
  Effect.gen(function* () {
    let teardownReached = false;
    const exit = yield* Effect.gen(function* () {
      yield* scopedLeaseCleanup(
        Effect.fail({
          _tag: "ReleaseProbeFailure",
          privateValue: "cleanup-secret",
        }),
      ).pipe(Effect.scoped);
      teardownReached = true;
    }).pipe(Effect.exit);
    expect(teardownReached).toBe(false);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.pretty(exit.cause)).toContain(
        "Lease cleanup failed (ReleaseProbeFailure)",
      );
      expect(Cause.pretty(exit.cause)).not.toContain("cleanup-secret");
    }
  }),
);

test(
  "pure lease cleanup retains the primary failure alongside cleanup failure",
  Effect.gen(function* () {
    const exit = yield* Effect.gen(function* () {
      yield* scopedLeaseCleanup(Effect.fail({ _tag: "ReleaseProbeFailure" }));
      return yield* Effect.fail("primary failure");
    }).pipe(Effect.scoped, Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.findError(exit.cause)).toEqual(
        Result.succeed("primary failure"),
      );
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.pretty(exit.cause)).toContain(
        "Lease cleanup failed (ReleaseProbeFailure)",
      );
    }
  }),
);

test(
  "pure lease cleanup timeout remains a test failure",
  Effect.gen(function* () {
    const exit = yield* scopedLeaseCleanup(
      Effect.never.pipe(Effect.timeout("1 millis")),
    ).pipe(Effect.scoped, Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain(
        "Lease cleanup failed (TimeoutError)",
      );
    }
  }),
);

test(
  "pure lease cleanup does not repeat a successful explicit release or confirmed absence",
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    yield* Effect.gen(function* () {
      const cleanup = yield* scopedLeaseCleanup(
        Ref.update(calls, (n) => n + 1),
      );
      yield* cleanup.release;
      yield* cleanup.release;
    }).pipe(Effect.scoped);
    expect(yield* Ref.get(calls)).toBe(1);
    yield* Effect.gen(function* () {
      const cleanup = yield* scopedLeaseCleanup(
        Ref.update(calls, (n) => n + 1),
      );
      yield* cleanup.complete;
    }).pipe(Effect.scoped);
    expect(yield* Ref.get(calls)).toBe(1);
  }),
);

const differentNonce = (nonce: string) =>
  `${nonce[0] === "a" ? "b" : "a"}${nonce.slice(1)}`;

test(
  "P4 pure HTTP 408 status mapping agrees with the Fly timeout model",
  Effect.sync(() => {
    expect(HTTP_STATUS_MAP[408]).toBe(GatewayTimeout);
    expect(RETRYABLE_HTTP_STATUSES.has(408)).toBe(true);
  }),
);

const observeTransport = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  return client.pipe(
    HttpClient.transform((response, request) =>
      response.pipe(
        Effect.tap((actual) =>
          Effect.logInfo("Fly SDK probe transport", {
            method: request.method,
            path: request.url.split("?")[0],
            status: actual.status,
            ttl:
              request.url.match(/[?&]ttl=(\d+)/)?.[1] ??
              request.urlParams.params.find(([key]) => key === "ttl")?.[1],
            nonceHeader: !!request.headers["fly-machine-lease-nonce"],
          }),
        ),
      ),
    ),
  );
});

const scopedLeaseCleanup = <A, E extends { readonly _tag: string }, R>(
  action: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const completed = yield* Ref.make(false);
    const complete = Ref.set(completed, true);
    const release = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (yield* Ref.get(completed)) return;
        yield* restore(action);
        yield* complete;
      }),
    );
    yield* Effect.addFinalizer(() =>
      release.pipe(
        Effect.interruptible,
        Effect.catchCause((cause) => {
          const error = Cause.findError(cause);
          const tag = Result.isSuccess(error)
            ? error.success._tag
            : Cause.hasInterrupts(cause)
              ? "Interrupted"
              : "Defect";
          return Effect.die(new Error(`Lease cleanup failed (${tag})`));
        }),
      ),
    );
    return { release, complete };
  });

const lease = (target: Target, ttl = 120) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("P1 acquiring native lease", {
      machineId: target.machine_id,
      ttl,
    });
    const acquired = yield* machines
      .createMachineLease({ ...target, ttl })
      .pipe(Effect.timeout("15 seconds"));
    const nonce = acquired.data?.nonce;
    if (!nonce)
      return yield* Effect.fail(new Error("Lease response has no nonce"));
    const cleanup = yield* scopedLeaseCleanup(
      machines
        .machinesReleaseLease({ ...target, lease_nonce: nonce })
        .pipe(Retry.none, Effect.timeout("15 seconds")),
    );
    return {
      acquired,
      nonce,
      release: cleanup.release,
      confirmDeleted: expectGone(target).pipe(Effect.andThen(cleanup.complete)),
      confirmExpired: Effect.gen(function* () {
        const now = yield* Effect.sync(() => Math.floor(Date.now() / 1000));
        expect(acquired.data?.expires_at).toBeLessThanOrEqual(now);
        const current = yield* machines.getMachineLease(target).pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.timeout("15 seconds"),
        );
        expect(current?.data?.nonce === nonce).toBe(false);
        yield* cleanup.complete;
      }),
    };
  });

const expectFailure = <A, E extends { readonly _tag: string }, R>(
  attempt: Effect.Effect<A, E, R>,
  tag: "Conflict" | "Forbidden" = "Conflict",
) =>
  attempt.pipe(
    Effect.result,
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure._tag).toBe(tag);
      }),
    ),
    Effect.asVoid,
  );

const waitState = (target: Target, state: string) =>
  machines.getMachine(target).pipe(
    Retry.none,
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (machine) => machine.state === state,
      times: 8,
    }),
    Effect.tap((machine) =>
      Effect.sync(() => expect(machine.state).toBe(state)),
    ),
  );

const expectGone = (target: Target) =>
  machines.getMachine(target).pipe(
    Retry.none,
    Effect.map((machine) => machine.state === "destroyed"),
    Effect.catchTag("NotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: Boolean,
      times: 8,
    }),
    Effect.tap((gone) => Effect.sync(() => expect(gone).toBe(true))),
  );

test.provider(
  "P1/P2 lease envelope, query TTL, renewal, contention and release on a real Machine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("LeaseSite");
          return yield* Fly.Machine("LeaseTarget", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
            skipLaunch: true,
          });
        }),
      );
      const target = {
        app_name: created.appName,
        machine_id: created.machineId,
      };
      const client = yield* observeTransport;
      yield* Effect.gen(function* () {
        const before = yield* Effect.sync(() => Math.floor(Date.now() / 1000));
        const held = yield* lease(target);
        const { acquired, nonce } = held;
        expect(acquired.status).toBe("success");
        expect(typeof acquired.data?.owner).toBe("string");
        expect(typeof acquired.data?.version).toBe("string");
        expect(acquired.data?.expires_at).toBeGreaterThanOrEqual(before + 115);
        expect(acquired.data?.expires_at).toBeLessThanOrEqual(before + 130);
        yield* Effect.logInfo("P1 lease envelope verified", {
          keys: Object.keys(acquired),
          dataKeys: Object.keys(acquired.data ?? {}),
          ttlSeconds: acquired.data!.expires_at! - before,
        });
        const observed = yield* machines.getMachineLease(target);
        expect(observed.data?.expires_at).toBe(acquired.data?.expires_at);
        yield* expectFailure(
          machines.createMachineLease({ ...target, ttl: 120 }),
        );
        yield* expectFailure(
          machines.createMachineLease({
            ...target,
            ttl: 120,
            lease_nonce: differentNonce(nonce),
          }),
        );
        yield* expectFailure(
          machines.machinesReleaseLease({
            ...target,
            lease_nonce: differentNonce(nonce),
          }),
          "Forbidden",
        );
        const refreshed = yield* machines.createMachineLease({
          ...target,
          ttl: 120,
          lease_nonce: nonce,
        });
        expect(refreshed.data?.nonce === nonce).toBe(true);
        expect(refreshed.data?.expires_at).toBeGreaterThanOrEqual(
          acquired.data!.expires_at!,
        );
        yield* held.release;
        const next = yield* lease(target);
        expect(next.nonce !== nonce).toBe(true);
      }).pipe(
        Effect.scoped,
        Retry.none,
        Effect.provideService(HttpClient.HttpClient, client),
      );
      yield* stack.destroy();
      yield* expectGone(target);
    }).pipe(sanitizeFailure),
  { timeout: 120_000 },
);

test.provider(
  "P1/P2 native nonce enforcement and metadata boundary on a real Machine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("EnforcementSite");
          return yield* Fly.Machine("EnforcementTarget", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
            restart: { policy: "always" },
            services: [
              {
                protocol: "tcp",
                internalPort: 80,
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
      const target = {
        app_name: created.appName,
        machine_id: created.machineId,
      };
      const client = yield* observeTransport;
      yield* Effect.gen(function* () {
        const held = yield* lease(target);
        const { acquired, nonce } = held;
        const verifyAuthority = (minimumRemainingSeconds = 0) =>
          Effect.gen(function* () {
            const held = yield* machines
              .getMachineLease(target)
              .pipe(Effect.timeout("15 seconds"));
            const now = yield* Effect.sync(() => Math.floor(Date.now() / 1000));
            expect(held.data?.nonce === nonce).toBe(true);
            expect(held.data?.owner === acquired.data?.owner).toBe(true);
            expect(held.data?.expires_at).toBeGreaterThan(
              now + minimumRemainingSeconds,
            );
          });
        const refreshAuthority = Effect.gen(function* () {
          yield* verifyAuthority(15);
          const refreshed = yield* machines
            .createMachineLease({ ...target, ttl: 120, lease_nonce: nonce })
            .pipe(Effect.timeout("15 seconds"));
          expect(refreshed.data?.nonce === nonce).toBe(true);
          // A complete request and its authority readback must fit inside the lease.
          yield* verifyAuthority(90);
        });
        const withAuthority = <A, E, R>(phase: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            yield* refreshAuthority;
            const value = yield* phase.pipe(Effect.timeout("60 seconds"));
            yield* verifyAuthority();
            return value;
          });
        const initial = yield* withAuthority(machines.getMachine(target));
        const outcomes: string[] = [];
        for (const lease_nonce of [undefined, differentNonce(nonce)]) {
          const request = { ...target, lease_nonce };
          const attempts = [
            [
              "update",
              machines.updateMachine({ ...request, config: initial.config }),
            ],
            ["start", machines.startMachine(request)],
            ["cordon", machines.cordonMachine(request)],
            ["uncordon", machines.uncordonMachine(request)],
            [
              "stop",
              machines.stopMachine({
                ...request,
                signal: "SIGTERM",
                timeout: "5s",
              }),
            ],
            ["suspend", machines.suspendMachine(request)],
            [
              "restart",
              machines.restartMachine({
                ...request,
                signal: "SIGTERM",
                timeout: "5s",
              }),
            ],
            ["delete", machines.deleteMachine({ ...request, force: true })],
          ] as const;
          for (const [operation, attempt] of attempts) {
            yield* refreshAuthority;
            const result = yield* attempt.pipe(
              Effect.timeout("60 seconds"),
              Effect.result,
            );
            yield* verifyAuthority();
            yield* Effect.logInfo("P1 mutation enforcement", {
              operation,
              nonce: lease_nonce ? "wrong" : "absent",
              outcome: Result.isFailure(result)
                ? result.failure._tag
                : "accepted",
            });
            outcomes.push(
              Result.isFailure(result) ? result.failure._tag : "accepted",
            );
            expect(Result.isFailure(result)).toBe(true);
          }
        }
        const intact = yield* withAuthority(machines.getMachine(target));
        expect(intact.state).toBe("started");
        expect(intact.instance_id).toBe(initial.instance_id);
        const metadata = yield* withAuthority(
          Effect.gen(function* () {
            yield* machines.upsertMachineMetadata({
              ...target,
              key: "lease-probe",
              value: "metadata-is-not-fenced",
            });
            const observed = yield* machines.getMachine(target);
            expect(observed.config?.metadata?.["lease-probe"]).toBe(
              "metadata-is-not-fenced",
            );
            return observed;
          }),
        );
        yield* Effect.logInfo("P2 metadata mutation bypasses target lease", {
          checksAfterMutation: metadata.checks?.length ?? 0,
        });
        const request = { ...target, lease_nonce: nonce };
        yield* withAuthority(
          Effect.gen(function* () {
            yield* machines.updateMachine({
              ...request,
              config: {
                ...metadata.config,
                env: { ...metadata.config?.env, LEASE_PROBE: "updated" },
              },
            });
            yield* waitState(target, "started");
            expect(
              (yield* machines.getMachine(target)).config?.env?.LEASE_PROBE,
            ).toBe("updated");
          }),
        );
        yield* withAuthority(
          Effect.gen(function* () {
            yield* machines.cordonMachine(request);
            expect((yield* machines.getMachine(target)).cordoned).toBe(true);
          }),
        );
        yield* withAuthority(
          Effect.gen(function* () {
            yield* machines.uncordonMachine(request);
            expect((yield* machines.getMachine(target)).cordoned).toBe(false);
          }),
        );
        yield* withAuthority(
          Effect.gen(function* () {
            yield* machines.stopMachine({
              ...request,
              signal: "SIGTERM",
              timeout: "5s",
            });
            yield* waitState(target, "stopped");
          }),
        );
        yield* withAuthority(
          Effect.gen(function* () {
            yield* machines.startMachine(request);
            yield* waitState(target, "started");
          }),
        );
        yield* withAuthority(
          Effect.gen(function* () {
            yield* machines.restartMachine({
              ...request,
              signal: "SIGTERM",
              timeout: "5s",
            });
            yield* waitState(target, "started");
          }),
        );
        yield* withAuthority(
          Effect.gen(function* () {
            yield* machines.suspendMachine(request);
            yield* waitState(target, "suspended");
          }),
        );
        yield* withAuthority(
          Effect.gen(function* () {
            yield* machines.stopMachine({
              ...request,
              signal: "SIGTERM",
              timeout: "5s",
            });
            yield* waitState(target, "stopped");
          }),
        );
        yield* refreshAuthority;
        yield* machines
          .deleteMachine(request)
          .pipe(Effect.timeout("60 seconds"));
        yield* held.confirmDeleted.pipe(Effect.timeout("30 seconds"));
        expect(outcomes).toEqual(Array(16).fill("Conflict"));
      }).pipe(
        Effect.scoped,
        Retry.none,
        Effect.provideService(HttpClient.HttpClient, client),
      );
      yield* stack.destroy();
      yield* expectGone(target);
    }).pipe(sanitizeFailure),
  { timeout: 30 * 60_000 },
);

test.provider(
  "P2 partial acquisition cleanup, expiry and lost authority during a real mutation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("LifetimeSite");
          return yield* Fly.Machine("LifetimeTargets", {
            app,
            region: "iad",
            image: "nginx:alpine",
            count: 2,
            guest: { cpus: 1, memoryMb: 256 },
            skipLaunch: true,
          });
        }),
      );
      const first = {
        app_name: created.appName,
        machine_id: created.machineIds[0]!,
      };
      const second = {
        app_name: created.appName,
        machine_id: created.machineIds[1]!,
      };
      yield* Effect.gen(function* () {
        yield* lease(first);
        const partial = yield* Effect.gen(function* () {
          yield* lease(second);
          yield* machines.createMachineLease({ ...first, ttl: 120 });
        }).pipe(Effect.scoped, Effect.result);
        expect(Result.isFailure(partial)).toBe(true);
        if (Result.isFailure(partial))
          expect(partial.failure).toMatchObject({ _tag: "Conflict" });
        const before = yield* Effect.sync(() => Math.floor(Date.now() / 1000));
        const expired = yield* lease(second, 2);
        expect(expired.acquired.data?.expires_at).toBeLessThanOrEqual(
          before + 5,
        );
        yield* Effect.sleep("3 seconds");
        const successor = yield* lease(second);
        expect(successor.nonce !== expired.nonce).toBe(true);
        yield* expired.confirmExpired;
        const observed = yield* machines.getMachine(second);
        yield* expectFailure(
          machines.updateMachine({
            ...second,
            lease_nonce: expired.nonce,
            config: observed.config,
            skip_launch: true,
          }),
        );
        yield* expectFailure(
          machines.createMachineLease({
            ...second,
            lease_nonce: expired.nonce,
            ttl: 120,
          }),
        );
        yield* expectFailure(
          machines.machinesReleaseLease({
            ...second,
            lease_nonce: expired.nonce,
          }),
          "Forbidden",
        );
        const stillHeld = yield* machines.getMachineLease(second);
        expect(stillHeld.data?.expires_at).toBe(
          successor.acquired.data?.expires_at,
        );
      }).pipe(Effect.scoped, Retry.none);
      yield* stack.destroy();
      yield* expectGone(first);
      yield* expectGone(second);
    }).pipe(sanitizeFailure),
  { timeout: 120_000 },
);

test.provider(
  "P4 duplicate create name Conflict permits exact owned Machine readback",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("IdentitySite");
          return yield* Fly.Machine("IdentityTarget", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
            skipLaunch: true,
          });
        }),
      );
      const target = {
        app_name: created.appName,
        machine_id: created.machineId,
      };
      const observed = yield* machines.getMachine(target);
      yield* expectFailure(
        machines
          .createMachine({
            app_name: created.appName,
            name: created.name,
            region: "iad",
            config: observed.config,
            skip_launch: true,
          })
          .pipe(Retry.none),
      );
      const matches = (yield* machines.listMachines({
        app_name: created.appName,
      })).filter(
        (machine) =>
          machine.name === created.name && machine.state !== "destroyed",
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.id).toBe(created.machineId);
      expect(matches[0]?.config?.metadata).toEqual(observed.config?.metadata);
      expect(matches[0]?.image_ref?.digest).toBe(observed.image_ref?.digest);
      yield* stack.destroy();
      yield* expectGone(target);
    }).pipe(sanitizeFailure),
  { timeout: 120_000 },
);

test.provider(
  "P4 lost completed create response reuses its unique owned name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(Fly.App("LostCreateSite"));
      const request: machines.CreateMachineRequest = {
        app_name: app.appName,
        name: "lost-create-target",
        region: "iad",
        skip_launch: true,
        config: {
          image: "nginx:alpine",
          guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
          metadata: { "sdk-probe-owner": "completed-response-loss" },
        },
      };
      yield* Effect.gen(function* () {
        const proxy = yield* dropCompletedCreate(app.appName);
        const result = yield* machines
          .createMachine(request)
          .pipe(
            Retry.none,
            Effect.provideService(Credentials, proxy.credentials),
            Effect.timeout("15 seconds"),
            Effect.result,
          );
        yield* Effect.logInfo("P4 transport fault outcome", {
          forwarded: yield* proxy.forwarded,
          completedStatus: yield* proxy.completedStatus,
          outcome: Result.isFailure(result) ? result.failure._tag : "accepted",
          rejection:
            Result.isFailure(result) && result.failure._tag === "BadRequest"
              ? result.failure.message
              : undefined,
        });
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("HttpClientError");
          if (result.failure._tag === "HttpClientError")
            expect(result.failure.reason._tag).toBe("TransportError");
        }
        expect(yield* proxy.forwarded).toBe(1);
        expect([200, 201]).toContain(yield* proxy.completedStatus);
        yield* Effect.logInfo("P4 completed create response dropped", {
          status: yield* proxy.completedStatus,
          forwarded: yield* proxy.forwarded,
        });
      }).pipe(Effect.scoped);
      const matches = (yield* machines.listMachines({
        app_name: app.appName,
      })).filter(
        (machine) =>
          machine.name === request.name && machine.state !== "destroyed",
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.config?.metadata?.["sdk-probe-owner"]).toBe(
        "completed-response-loss",
      );
      yield* expectFailure(machines.createMachine(request).pipe(Retry.none));
      const after = (yield* machines.listMachines({
        app_name: app.appName,
      })).filter(
        (machine) =>
          machine.name === request.name && machine.state !== "destroyed",
      );
      expect(after.map((machine) => machine.id)).toEqual(
        matches.map((machine) => machine.id),
      );
      yield* stack.destroy();
      yield* expectGone({ app_name: app.appName, machine_id: matches[0]!.id! });
    }).pipe(sanitizeFailure),
  { timeout: 120_000 },
);

const p3CheckNames = [
  "servicecheck-00-http-80",
  "servicecheck-00-tcp-80",
  "ready",
];

interface RestoredReadiness {
  previousInstance: string;
  after: number;
  checks: ReadonlyMap<string, number>;
}

const readyCheckReports = (
  reports: ReadonlyArray<machines.CheckStatus> | undefined,
  freshness?: RestoredReadiness,
) =>
  p3CheckNames.every((name) => {
    const matching = reports?.filter((check) => check.name === name) ?? [];
    if (matching.length !== 1 || matching[0]!.status !== "passing")
      return false;
    const observedAt = Date.parse(matching[0]!.updated_at ?? "");
    if (!Number.isFinite(observedAt)) return false;
    if (!freshness) return true;
    const previous = freshness.checks.get(name);
    return (
      previous !== undefined &&
      Number.isFinite(previous) &&
      observedAt > previous &&
      observedAt >= freshness.after
    );
  });

const wireAutostop = (value: string | boolean | undefined) =>
  value === true ? "stop" : value === false ? "off" : value;

test(
  "P3 pure readiness rejects stale, missing, duplicate and undated check observations",
  Effect.sync(() => {
    const freshness: RestoredReadiness = {
      previousInstance: "prepared",
      after: 2_000,
      checks: new Map(p3CheckNames.map((name) => [name, 1_000])),
    };
    const reports = p3CheckNames.map((name) => ({
      name,
      status: "passing",
      updated_at: new Date(3_000).toISOString(),
    }));
    expect(readyCheckReports(reports, freshness)).toBe(true);
    for (const updated_at of [
      new Date(1_000).toISOString(),
      new Date(1_500).toISOString(),
      "invalid",
      undefined,
    ]) {
      expect(
        readyCheckReports(
          [{ ...reports[0]!, updated_at }, ...reports.slice(1)],
          freshness,
        ),
      ).toBe(false);
    }
    expect(readyCheckReports(reports.slice(1), freshness)).toBe(false);
    expect(readyCheckReports([...reports, reports[0]!], freshness)).toBe(false);
  }),
);

test(
  "P3 pure autostop schema accepts strings and legacy booleans",
  Effect.sync(() => {
    const decode = Schema.decodeUnknownSync(machines.FlyMachineServiceAutostop);
    for (const value of ["off", "stop", "suspend", false, true]) {
      expect(decode(value)).toBe(value);
    }
    expect(() => decode({ mode: "stop" })).toThrow();
    expect(() => decode(1)).toThrow();
  }),
);

for (const autostop of ["stop", "suspend"] as const) {
  test.provider(
    `P3 ${autostop} cordoned representative, restored checks and public autostart`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("IdleSite");
            yield* Fly.IpAssignment("Public", { app, type: "shared_v4" });
            return yield* Fly.Machine("IdleTargets", {
              app,
              region: "iad",
              image: "nginx:alpine",
              count: 2,
              guest: { cpus: 1, memoryMb: 256 },
              skipLaunch: true,
              checks: {
                ready: {
                  type: "http",
                  port: 80,
                  path: "/",
                  interval: "2s",
                  timeout: "1s",
                },
              },
              services: [
                {
                  protocol: "tcp",
                  internalPort: 80,
                  autostop,
                  autostart: true,
                  minMachinesRunning: 1,
                  ports: [{ port: 443, handlers: ["tls", "http"] }],
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
                {
                  protocol: "tcp",
                  internalPort: 80,
                  autostop,
                  autostart: true,
                  minMachinesRunning: 0,
                  ports: [{ port: 8080, handlers: ["http"] }],
                  // Identical HTTP checks reported only one service-check identity.
                  checks: [
                    {
                      type: "tcp",
                      port: 80,
                      interval: "2s",
                      timeout: "1s",
                    },
                  ],
                },
              ],
            });
          }),
        );
        const target = {
          app_name: created.appName,
          machine_id: created.machineIds[0]!,
        };
        const idle = {
          app_name: created.appName,
          machine_id: created.machineIds[1]!,
        };
        const client = yield* observeTransport;
        const healthy = (
          mode: "off" | "stop" | "suspend",
          freshness?: RestoredReadiness,
        ) => {
          const isReady = (machine: machines.Machine) => {
            const services = machine.config?.services;
            return (
              machine.state === "started" &&
              machine.cordoned === true &&
              !!machine.instance_id &&
              (!freshness ||
                machine.instance_id !== freshness.previousInstance) &&
              readyCheckReports(machine.checks, freshness) &&
              services?.length === 2 &&
              services.every(
                (service, index) =>
                  wireAutostop(service.autostop) === mode &&
                  service.autostart === true &&
                  service.min_machines_running === (index === 0 ? 1 : 0),
              )
            );
          };
          return machines.getMachine(target).pipe(
            Retry.none,
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              times: 8,
              until: isReady,
            }),
            Effect.tap((machine) =>
              Effect.logInfo("P3 observed readiness reports", {
                state: machine.state,
                instance: machine.instance_id,
                checks: machine.checks?.map((check) => ({
                  name: check.name,
                  status: check.status,
                  updatedAt: check.updated_at,
                })),
                named: Object.keys(machine.config?.checks ?? {}),
                serviceCheckCounts: machine.config?.services?.map(
                  (service) => service.checks?.length ?? 0,
                ),
              }),
            ),
            Effect.tap((machine) =>
              Effect.sync(() => expect(isReady(machine)).toBe(true)),
            ),
          );
        };
        yield* Effect.gen(function* () {
          const held = yield* lease(target);
          const { nonce } = held;
          const other = yield* lease(idle);
          const request = { ...target, lease_nonce: nonce };
          const initial = yield* machines.getMachine(target);
          const config = initial.config!;
          yield* machines.updateMachine({
            ...request,
            config: {
              ...config,
              services: config.services?.map((service) => ({
                ...service,
                autostop: "off",
              })),
            },
            skip_launch: true,
            skip_service_registration: true,
          });
          yield* machines.cordonMachine({ ...idle, lease_nonce: other.nonce });
          yield* machines.cordonMachine(request);
          yield* machines.startMachine(request).pipe(
            Effect.retry({
              while: (error) => error._tag === "MachineReplacing",
              schedule: Schedule.spaced("2 seconds"),
              times: 8,
            }),
            Effect.timeout("20 seconds"),
          );
          yield* waitState(target, "started");
          const prepared = yield* healthy("off");
          expect(prepared.cordoned).toBe(true);
          expect(["created", "stopped"]).toContain(
            (yield* machines.getMachine(idle)).state,
          );
          if (!prepared.instance_id) {
            return yield* Effect.fail(
              new Error("Prepared Machine has no instance ID"),
            );
          }
          const previousChecks = yield* Effect.sync(
            () =>
              new Map<string, number>(
                p3CheckNames.map((name) => [
                  name,
                  Date.parse(
                    prepared.checks?.find((check) => check.name === name)
                      ?.updated_at ?? "",
                  ),
                ]),
              ),
          );
          const freshness: RestoredReadiness = {
            previousInstance: prepared.instance_id,
            checks: previousChecks,
            after: yield* Effect.sync(() => Date.now()),
          };
          yield* machines.updateMachine({
            ...request,
            config,
            skip_service_registration: true,
          });
          yield* waitState(target, "started");
          const restored = yield* healthy(autostop, freshness);
          expect(restored.instance_id).not.toBe(prepared.instance_id);
          expect(readyCheckReports(restored.checks, freshness)).toBe(true);
          yield* Effect.logInfo("P3 restored idle policy", {
            autostop,
            instanceChanged: prepared.instance_id !== restored.instance_id,
            services: restored.config?.services?.map((service) => ({
              autostop: service.autostop,
              autostart: service.autostart,
              minimum: service.min_machines_running,
            })),
            checks: restored.checks?.map((check) => ({
              name: check.name,
              status: check.status,
              updatedAt: check.updated_at,
            })),
          });
          expect(
            restored.config?.services?.map(
              (service) => service.min_machines_running,
            ),
          ).toEqual([1, 0]);
          expect(
            restored.config?.services?.map((service) =>
              wireAutostop(service.autostop),
            ),
          ).toEqual([autostop, autostop]);
          expect(
            restored.config?.services?.map((service) => service.autostart),
          ).toEqual([true, true]);
          yield* machines.uncordonMachine(request);
          yield* machines.uncordonMachine({
            ...idle,
            lease_nonce: other.nonce,
          });
          if (autostop === "suspend") {
            yield* machines
              .suspendMachine(request)
              .pipe(Effect.timeout("15 seconds"));
            yield* waitState(target, "suspended");
          } else {
            yield* machines.stopMachine({
              ...request,
              signal: "SIGTERM",
              timeout: "5s",
            });
            yield* waitState(target, "stopped");
          }
          // Fly Proxy must be free to start either Machine without our nonce.
          yield* held.release;
          yield* other.release;
          yield* Effect.logInfo(
            "P3 released own leases before proxy autostart",
          );
          const beforeRequest = (yield* machines.listMachines({
            app_name: created.appName,
          })).filter(
            (machine) =>
              machine.id === target.machine_id ||
              machine.id === idle.machine_id,
          );
          expect(beforeRequest.length).toBe(2);
          expect(
            beforeRequest.every(
              (machine) =>
                machine.state === "created" ||
                machine.state === "stopped" ||
                machine.state === "suspended",
            ),
          ).toBe(true);
          const response = yield* client
            .pipe(HttpClient.filterStatusOk)
            .get(`https://${created.appName}.fly.dev`)
            .pipe(
              Effect.timeout("5 seconds"),
              Effect.retry({
                schedule: Schedule.spaced("2 seconds"),
                times: 3,
              }),
            );
          expect(response.status).toBe(200);
          const states = yield* machines.listMachines({
            app_name: created.appName,
          });
          expect(
            states.some(
              (machine) =>
                machine.state === "started" &&
                beforeRequest.some((before) => before.id === machine.id),
            ),
          ).toBe(true);
          yield* Effect.logInfo("P3 public proxy autostart verified", {
            autostop,
            states: states.map((machine) => machine.state),
          });
        }).pipe(
          Effect.scoped,
          Retry.none,
          Effect.provideService(HttpClient.HttpClient, client),
        );
        yield* stack.destroy();
        yield* expectGone(target);
        yield* expectGone(idle);
      }).pipe(sanitizeFailure),
    { timeout: 5 * 60_000 },
  );
}
