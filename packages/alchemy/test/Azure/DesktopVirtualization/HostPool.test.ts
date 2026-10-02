import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as desktopvirtualization from "@distilled.cloud/azure/desktopvirtualization";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getHostPool = (resourceGroupName: string, hostPoolName: string) =>
  Effect.gen(function* () {
    return yield* desktopvirtualization.GetHostPool({
      subscriptionId: yield* subscription,
      resourceGroupName,
      hostPoolName,
    });
  });

const program = (
  props: Pick<
    Azure.DesktopVirtualization.HostPoolProps,
    | "hostPoolType"
    | "loadBalancerType"
    | "personalDesktopAssignmentType"
    | "maxSessionLimit"
    | "friendlyName"
    | "registrationTokenTtlHours"
    | "tags"
  >,
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const pool = yield* Azure.DesktopVirtualization.HostPool("Pool", {
      resourceGroup: group.resourceGroupName,
      location,
      ...props,
    });
    return { group, pool };
  });

// Host pools are free metadata objects; seconds to create.
test.provider(
  "create, update, replace, and delete a host pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, pool } = yield* stack.deploy(
        program({
          hostPoolType: "Pooled",
          loadBalancerType: "BreadthFirst",
          maxSessionLimit: 5,
          friendlyName: "Pool v1",
          registrationTokenTtlHours: 24,
          tags: { env: "test" },
        }),
      );
      const rg = group.resourceGroupName;
      expect(pool.hostPoolType).toEqual("Pooled");
      expect(pool.registrationToken).toBeDefined();
      const token = Redacted.value(pool.registrationToken!);
      expect(token.length).toBeGreaterThan(20);
      expect(pool.tags).toEqual({ env: "test" });
      const observed = yield* getHostPool(rg, pool.hostPoolName);
      expect(observed.properties.maxSessionLimit).toEqual(5);
      expect(observed.properties.friendlyName).toEqual("Pool v1");
      expect(observed.properties.loadBalancerType).toEqual("BreadthFirst");
      expect(observed.tags?.["alchemy::id"]).toEqual("Pool");

      // In place: session limit, load balancing, name, tags. The valid
      // registration token is reused, not rotated.
      const updated = yield* stack.deploy(
        program({
          hostPoolType: "Pooled",
          loadBalancerType: "DepthFirst",
          maxSessionLimit: 8,
          friendlyName: "Pool v2",
          registrationTokenTtlHours: 24,
          tags: { env: "prod" },
        }),
      );
      expect(updated.pool.hostPoolId).toEqual(pool.hostPoolId);
      expect(Redacted.value(updated.pool.registrationToken!)).toEqual(token);
      const reobserved = yield* getHostPool(rg, pool.hostPoolName);
      expect(reobserved.properties.maxSessionLimit).toEqual(8);
      expect(reobserved.properties.friendlyName).toEqual("Pool v2");
      expect(reobserved.properties.loadBalancerType).toEqual("DepthFirst");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the host pool type is immutable.
      const replaced = yield* stack.deploy(
        program({
          hostPoolType: "Personal",
          personalDesktopAssignmentType: "Automatic",
          loadBalancerType: "Persistent",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.pool.hostPoolName).not.toEqual(pool.hostPoolName);
      const personal = yield* getHostPool(rg, replaced.pool.hostPoolName);
      expect(personal.properties.hostPoolType).toEqual("Personal");
      expect(personal.properties.personalDesktopAssignmentType).toEqual(
        "Automatic",
      );
      expect(yield* waitGone(getHostPool(rg, pool.hostPoolName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(getHostPool(rg, replaced.pool.hostPoolName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
