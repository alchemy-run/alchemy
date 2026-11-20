import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as warmPools from "@distilled.cloud/daytona/warm_pools";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Daytona.providers() });

// Daytona Cloud (v0.229) does not serve warm pools; set
// DAYTONA_TEST_WARM_POOLS=1 against a deployment that does.
const warmPoolsAvailable = !!process.env.DAYTONA_TEST_WARM_POOLS;

test.provider.skipIf(warmPoolsAvailable)(
  "a deployment without warm pools fails with WarmPoolsUnavailable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(
          Daytona.WarmPool("Pool", { snapshot: { name: "daytonaio/sandbox:0.11.0" }, size: 1 }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("WarmPoolsUnavailable");
      yield* stack.destroy();
    }),
  { tags: ["provider:daytona", "live"], timeout: 120_000 },
);

// A warm pool keeps started sandboxes running, which Daytona bills.
test.provider.skipIf(!!process.env.FAST || !warmPoolsAvailable)(
  "keep a sandbox warm, resize the pool in place, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const base = yield* Daytona.Snapshot("PoolBase", {
            image: "node:22-bookworm-slim",
            cpu: 1,
            memory: 1,
            disk: 3,
          });
          return yield* Daytona.WarmPool("Pool", { snapshot: base, size: 1 });
        }),
      );
      expect(created.size).toEqual(1);

      const resized = yield* stack.deploy(
        Effect.gen(function* () {
          const base = yield* Daytona.Snapshot("PoolBase", {
            image: "node:22-bookworm-slim",
            cpu: 1,
            memory: 1,
            disk: 3,
          });
          return yield* Daytona.WarmPool("Pool", { snapshot: base, size: 2 });
        }),
      );
      expect(resized.warmPoolId).toEqual(created.warmPoolId);
      const observed = (yield* warmPools.listWarmPools({})).find(
        (p) => p.id === created.warmPoolId,
      );
      expect(observed?.pool).toEqual(2);

      yield* stack.destroy();
      expect((yield* warmPools.listWarmPools({})).some((p) => p.id === created.warmPoolId)).toBe(
        false,
      );
    }),
  { tags: ["provider:daytona", "live", "slow"], timeout: 1_200_000 },
);
