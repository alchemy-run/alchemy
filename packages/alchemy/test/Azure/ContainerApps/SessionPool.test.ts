import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, waitGone } from "./fixtures/shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPool = (resourceGroupName: string, sessionPoolName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetContainerAppsSessionPool({
      subscriptionId,
      resourceGroupName,
      sessionPoolName,
    });
  });

const program = (props: {
  location?: string;
  maxConcurrentSessions: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const pool = yield* Azure.ContainerApps.SessionPool("Pool", {
      resourceGroup: group.resourceGroupName,
      location: props.location ?? "eastus",
      containerType: "PythonLTS",
      scaleConfiguration: {
        maxConcurrentSessions: props.maxConcurrentSessions,
        readySessionInstances: 1,
      },
      dynamicPoolConfiguration: {
        lifecycleConfiguration: {
          lifecycleType: "Timed",
          cooldownPeriodInSeconds: 300,
        },
      },
      sessionNetworkStatus: "EgressDisabled",
      tags: props.tags,
    });
    return { group, pool };
  });

// Cost: one pre-warmed Python session for a few minutes (unallocated ready
// sessions are not billed; < $0.01 worst case). Time: 1-3 minutes.
test.provider(
  "create, update, replace, and delete a session pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, pool } = yield* stack.deploy(
        program({ maxConcurrentSessions: 5, tags: { env: "test" } }),
      );
      expect(pool.sessionPoolName).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
      expect(pool.containerType).toEqual("PythonLTS");
      expect(pool.poolManagementEndpoint).toMatch(/^https:\/\//);

      const observed = yield* getPool(
        group.resourceGroupName,
        pool.sessionPoolName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.scaleConfiguration?.maxConcurrentSessions,
      ).toEqual(5);
      expect(observed.properties?.poolManagementType).toEqual("Dynamic");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Pool");

      // In-place update: scale and tags.
      const updated = yield* stack.deploy(
        program({ maxConcurrentSessions: 8, tags: { env: "prod" } }),
      );
      expect(updated.pool.sessionPoolId).toEqual(pool.sessionPoolId);
      const reobserved = yield* getPool(
        group.resourceGroupName,
        pool.sessionPoolName,
      );
      expect(
        reobserved.properties?.scaleConfiguration?.maxConcurrentSessions,
      ).toEqual(8);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a new location deletes the old pool, then creates the
      // new one (the free trial allows one session pool per subscription).
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          maxConcurrentSessions: 8,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.pool.sessionPoolName).not.toEqual(pool.sessionPoolName);
      expect(replaced.pool.location.toLowerCase().replaceAll(" ", "")).toEqual(
        "westus2",
      );
      expect(
        yield* waitGone(getPool(group.resourceGroupName, pool.sessionPoolName)),
      ).toEqual("gone");
      const replacement = yield* getPool(
        group.resourceGroupName,
        replaced.pool.sessionPoolName,
      );
      expect(replacement.properties?.provisioningState).toEqual("Succeeded");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getPool(group.resourceGroupName, replaced.pool.sessionPoolName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 600_000,
  },
);
