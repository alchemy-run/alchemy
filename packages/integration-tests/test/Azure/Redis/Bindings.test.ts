import * as Azure from "@alchemy.run/azure";
import type { ArmResourceId } from "@alchemy.run/azure/internal/ArmActionBinding";
import * as redis from "@distilled.cloud/azure/redis";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  awaitGrants,
  awaitNoGrants,
  azure,
  call,
  expectOk,
  probe,
} from "../arm-action-bindings.ts";
import { runExpensive } from "../gates.ts";
import RedisFunction, { Cache } from "./fixtures/function.ts";
import { subscription, tags, waitGone } from "./util.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureRedisBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* RedisFunction;
    const cache = yield* Cache;
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      resourceGroup: cache.resourceGroup,
      cacheName: cache.cacheName,
      cacheId: cache.cacheId,
    };
  }),
);

// A Basic C0 cache (~$0.02/hour) plus a Flex Consumption app: ~$0.01/run,
// but the cache takes 15-25 min to create, so the suite runs only with
// AZURE_TEST_EXPENSIVE=1 (as the Cache suite does).
const stack = runExpensive ? beforeAll(deploy(Stack), { timeout: 2_700_000 }) : undefined;

const url = Effect.suspend(() => Effect.map(stack!, (outputs) => outputs.url));

const cacheOf = (id: ArmResourceId) => ({
  subscriptionId: id.subscriptionId,
  resourceGroupName: id.resourceGroupName,
  cacheName: id.name("redis"),
});

const namedCacheOf = (id: ArmResourceId) => ({
  subscriptionId: id.subscriptionId,
  resourceGroupName: id.resourceGroupName,
  name: id.name("redis"),
});

// Ungated: each binding's request, with the identifiers it derives from the
// bound cache's ARM ID, reaches ARM's route for the action. Export and
// import need a Premium cache (~$0.55/hour, 30+ min to create); they are
// covered here only.
describe("Redis runtime-action requests", { tags }, () => {
  for (const [binding, send] of [
    ["FlushCache", (id: ArmResourceId) => redis.FlushRedisCache(cacheOf(id))],
    [
      "ExportCacheData",
      (id: ArmResourceId) =>
        redis.ExportRedisData({
          ...namedCacheOf(id),
          prefix: "probe",
          container: "https://probe.blob.core.windows.net/redis",
        }),
    ],
    [
      "ImportCacheData",
      (id: ArmResourceId) =>
        redis.ImportRedisData({
          ...namedCacheOf(id),
          files: ["https://probe.blob.core.windows.net/redis/probe"],
        }),
    ],
  ] as const) {
    test(
      `Redis.${binding} addresses the bound cache`,
      Effect.gen(function* () {
        const tag = yield* probe("Microsoft.Cache/redis/redisprobe", send);
        expect(tag).toEqual("ResourceGroupNotFound");
      }),
    );
  }
});

describe.skipIf(!runExpensive)("Redis bindings on an Azure Function", { tags }, () => {
  // A flush has no ARM-visible result: the test proves Azure accepted it
  // (no `AuthorizationFailed`) and the cache stays healthy.
  describe("Redis.FlushCache", () => {
    test(
      "flushes the bound cache",
      Effect.gen(function* () {
        const body = yield* call(url, "/flush");
        expectOk(body);
        expect(body.result).toEqual({ accepted: true });
        const { resourceGroup, cacheName } = yield* stack!;
        const subscriptionId = yield* subscription.pipe(Effect.provide(azure));
        const state = yield* redis
          .GetRedis({ subscriptionId, resourceGroupName: resourceGroup, name: cacheName })
          .pipe(
            Effect.map((cache) => cache.properties?.provisioningState),
            Effect.repeat({
              schedule: Schedule.spaced("15 seconds"),
              until: (observed) => observed === "Succeeded",
              times: 20,
            }),
            Effect.provide(azure),
          );
        expect(state).toEqual("Succeeded");
      }),
      { timeout: 900_000 },
    );
  });

  describe("AzureBindings.Bind least privilege", () => {
    test(
      "assigns exactly the flush action on the cache only",
      Effect.gen(function* () {
        const outputs = yield* stack!;
        const grants = yield* awaitGrants(outputs.principalId!, outputs.hostStorageAccount, 1);
        expect(grants).toEqual([
          `Microsoft.Cache/redis/flush/action ${outputs.cacheId.toLowerCase()}`,
        ]);
      }),
      { timeout: 300_000 },
    );
  });
});

if (runExpensive) {
  // Destroy, then prove the cache and every role on the Function's identity are gone.
  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const { principalId, hostStorageAccount, resourceGroup, cacheName } = yield* stack!;
      yield* destroy(Stack);
      expect(yield* awaitNoGrants(principalId!, hostStorageAccount)).toEqual([]);
      const subscriptionId = yield* subscription;
      expect(
        yield* waitGone(
          redis.GetRedis({ subscriptionId, resourceGroupName: resourceGroup, name: cacheName }),
        ),
      ).toEqual("gone");
    }).pipe(Effect.provide(azure)),
    { timeout: 2_700_000 },
  );
}
