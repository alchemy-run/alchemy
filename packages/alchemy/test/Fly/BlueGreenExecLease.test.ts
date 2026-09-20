import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import * as Fly from "@/Fly";
import { makeMachineLeases } from "@/Fly/leases";
import * as Test from "@/Test/Alchemy";
import { expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { assertAppGone, checks } from "./fixtures/bluegreen.ts";
import { sanitizeExecFailure } from "./fixtures/exec-lease.ts";

const { test } = Test.make({ providers: Fly.providers() });

it.effect(
  "exec probe sanitizes failures and defects without losing interruption",
  () =>
    Effect.gen(function* () {
      const privateHeader = "fixture-private-lease-header";
      const outcome = yield* Effect.failCause(
        Cause.fromReasons([
          Cause.makeFailReason(new Error(privateHeader)),
          Cause.makeDieReason({
            headers: { "fly-machine-lease-nonce": privateHeader },
          }),
          Cause.makeInterruptReason(123),
        ]),
      ).pipe(sanitizeExecFailure, Effect.exit);
      expect(Exit.isFailure(outcome)).toBe(true);
      if (Exit.isFailure(outcome)) {
        expect(outcome.cause.reasons.map((reason) => reason._tag)).toEqual([
          "Fail",
          "Die",
          "Interrupt",
        ]);
        expect(Cause.pretty(outcome.cause)).not.toContain(privateHeader);
        const interrupted = outcome.cause.reasons.find(Cause.isInterruptReason);
        expect(interrupted?.fiberId).toBe(123);
      }
    }),
);

test.provider(
  "exec remains blocked during a native lease even with its nonce and succeeds after observable release",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("ExecLeaseSite");
          return yield* Fly.Machine("ExecLeaseTarget", {
            app,
            region: "iad",
            image: "nginx:alpine",
            guest: { cpus: 1, memoryMb: 256 },
            checks,
            deploy: { strategy: "bluegreen", healthTimeout: "30 seconds" },
            shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
          });
        }),
      );
      const target = {
        app_name: created.appName,
        machine_id: created.machineId,
      };
      const command = ["/bin/sh", "-c", "printf lease-exec-ok"];
      yield* Effect.gen(function* () {
        const leases = yield* makeMachineLeases(created.appName);
        yield* leases.acquire([created.machineId]);
        yield* leases.guard(
          Effect.gen(function* () {
            const verifyAuthority = Effect.gen(function* () {
              const current = yield* machines
                .getMachineLease(target)
                .pipe(Retry.none, Effect.timeout("15 seconds"));
              const nonce = current.data?.nonce;
              if (!nonce)
                return yield* Effect.fail(
                  new Error("Owned Machine lease response has no nonce"),
                );
              expect(
                nonce === (yield* leases.nonceIfHeld(created.machineId)),
              ).toBe(true);
              expect(current.data?.expires_at).toBeGreaterThan(
                (yield* Clock.currentTimeMillis) / 1000 + 15,
              );
              return nonce;
            });
            const client = yield* HttpClient.HttpClient;
            for (const header of ["held", "missing", "wrong"] as const) {
              const nonce = yield* verifyAuthority;
              const value =
                header === "held"
                  ? nonce
                  : `${nonce[0] === "a" ? "b" : "a"}${nonce.slice(1)}`;
              let observed = false;
              // Probe the general lease header without advertising unsupported exec authorization.
              const probeClient = HttpClient.mapRequest(client, (request) =>
                header === "missing"
                  ? request
                  : HttpClientRequest.setHeader(
                      request,
                      "fly-machine-lease-nonce",
                      value,
                    ),
              ).pipe(
                HttpClient.tapRequest((request) =>
                  Effect.sync(() => {
                    observed = true;
                    expect(
                      request.headers["fly-machine-lease-nonce"] ===
                        (header === "missing" ? undefined : value),
                    ).toBe(true);
                  }),
                ),
              );
              const outcome = yield* machines
                .execMachine({
                  ...target,
                  command,
                  timeout: 5,
                })
                .pipe(
                  Retry.none,
                  Effect.timeout("15 seconds"),
                  Effect.provideService(HttpClient.HttpClient, probeClient),
                  Effect.as("accepted" as const),
                  Effect.catchTag("Conflict", () =>
                    Effect.succeed("Conflict" as const),
                  ),
                );
              expect(observed).toBe(true);
              expect(outcome).toBe("Conflict");
              yield* verifyAuthority;
            }
          }).pipe(Effect.timeout("90 seconds")),
        );
      }).pipe(Effect.scoped);

      const released = yield* machines.getMachineLease(target).pipe(
        Retry.none,
        Effect.timeout("15 seconds"),
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
      expect(released).toBe(true);
      expect((yield* machines.getMachine(target)).state).toBe("started");
      const unleased = yield* machines
        .execMachine({
          ...target,
          command,
          timeout: 5,
        })
        .pipe(Retry.none, Effect.timeout("15 seconds"));
      expect(unleased.exit_code).toBe(0);
      expect(unleased.stdout).toBe("lease-exec-ok");
      yield* stack.destroy();
      yield* assertAppGone(created.appName);
    }).pipe(sanitizeExecFailure),
  { timeout: 300_000 },
);
