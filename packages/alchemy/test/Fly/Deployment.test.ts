import type { FlyMachineConfig } from "@distilled.cloud/fly-io/machines";
import { deploymentPolicy, validateDeployment } from "@/Fly/Deployment";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

it.effect("deployment defaults preserve existing behavior", () =>
  Effect.gen(function* () {
    const rolling = yield* deploymentPolicy(undefined, undefined);
    expect(rolling.bluegreen).toBe(false);
    expect(rolling.shutdown).toBeUndefined();
    const bluegreen = yield* deploymentPolicy(
      { strategy: "bluegreen" },
      undefined,
    );
    expect(bluegreen.healthTimeoutMs).toBe(60_000);
    expect(bluegreen.shutdown).toEqual({
      signal: "SIGTERM",
      timeout: "30000ms",
      timeoutMs: 30_000,
    });
  }),
);

for (const timeout of [0, -1, 300_001, Infinity, 0.1]) {
  it.effect(`rejects invalid shutdown duration ${timeout}`, () =>
    Effect.gen(function* () {
      const error = yield* deploymentPolicy(undefined, { timeout }).pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("Fly.InvalidDeployment");
    }),
  );
}

it.effect("rejects unsupported bluegreen configuration before mutation", () =>
  Effect.gen(function* () {
    const policy = yield* deploymentPolicy(
      { strategy: "bluegreen" },
      undefined,
    );
    const checks = { ready: { type: "http", port: 80, path: "/" } };
    const cases: Array<[FlyMachineConfig, boolean, boolean]> = [
      [{}, false, false],
      [{ checks }, true, false],
      [{ checks }, false, true],
      [{ checks, auto_destroy: true }, false, false],
      [{ checks, restart: { policy: "no" } }, false, false],
      [{ checks, services: [{ ports: [{ port: 80 }] }] }, false, false],
      [{ checks, services: [{ autostop: "stop" }] }, false, false],
    ];
    for (const [config, mounted, skip] of cases) {
      const error = yield* validateDeployment(
        policy,
        config,
        mounted,
        skip,
      ).pipe(Effect.flip);
      expect(error._tag).toBe("Fly.InvalidDeployment");
    }
    const signal = yield* deploymentPolicy(
      undefined,
      { signal: "SIGQUIT" },
      true,
    ).pipe(Effect.flip);
    expect(signal._tag).toBe("Fly.InvalidDeployment");
  }),
);
