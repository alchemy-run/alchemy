import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  consumptionService,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCache = (
  resourceGroupName: string,
  serviceName: string,
  cacheId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetCache({ subscriptionId, resourceGroupName, serviceName, cacheId }),
  );

// APIM stores the connection string without connecting, so a placeholder
// Redis host keeps the test free of a Redis instance.
const connection = (password: string) =>
  Redacted.make(
    `alchemy-placeholder.redis.cache.windows.net:6380,password=${password},ssl=True,abortConnect=False`,
  );

const program = (cache?: {
  name: string;
  description: string;
  password: string;
}) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const created = cache
      ? yield* Azure.ApiManagement.Cache("Redis", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: cache.name,
          connectionString: connection(cache.password),
          description: cache.description,
        })
      : undefined;
    return { group, service, cache: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete an external cache",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "default", description: "first", password: "one" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.cache?.cacheName).toEqual("default");
      expect(first.cache?.useFromLocation).toEqual("default");
      expect(
        (yield* getCache(rg, svc, "default")).properties?.description,
      ).toEqual("first");

      // In-place update: description and rotated password.
      yield* stack.deploy(
        program({ name: "default", description: "second", password: "two" }),
      );
      expect(
        (yield* getCache(rg, svc, "default")).properties?.description,
      ).toEqual("second");

      // Replacement: a region-specific cache entity replaces the default one.
      const replaced = yield* stack.deploy(
        program({ name: "eastus", description: "second", password: "two" }),
      );
      expect(replaced.cache?.cacheName).toEqual("eastus");
      expect(yield* untilGone(getCache(rg, svc, "default"))).toEqual("gone");

      // Removing the resource deletes the cache entity.
      yield* stack.deploy(program());
      expect(yield* untilGone(getCache(rg, svc, "eastus"))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
