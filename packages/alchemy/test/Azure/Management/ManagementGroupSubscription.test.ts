import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as management from "@distilled.cloud/azure/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Moving the subscription the whole test fleet runs in changes the policy
 * and RBAC it inherits for every concurrent test, so this lifecycle only
 * runs with `AZURE_TEST_MG_SUBSCRIPTION_MOVE=1` ($0, ~3-15 min: a new
 * management group is unusable until the creator's Owner grant propagates).
 */
const runSubscriptionMove = !!process.env.AZURE_TEST_MG_SUBSCRIPTION_MOVE;

/** The subscription's parent management group, read through the root. */
const parentOf = (groupId: string, subscriptionId: string) =>
  management
    .GetManagementGroupSubscriptionSubscription({ groupId, subscriptionId })
    .pipe(
      Effect.map((s) => s.properties?.parent?.id?.split("/").pop()),
      Effect.catchTag(["ManagementGroupNotFound", "NotFound"], () =>
        Effect.succeed(undefined),
      ),
      Effect.retry({
        while: (e) => e._tag === "AuthorizationFailed",
        schedule: Schedule.spaced("10 seconds"),
        times: 30,
      }),
    );

const program = (target: "A" | "B" | "none") =>
  Effect.gen(function* () {
    const a = yield* Azure.Management.ManagementGroup("GroupA", {
      displayName: "Alchemy subscription test A",
    });
    const b = yield* Azure.Management.ManagementGroup("GroupB", {
      displayName: "Alchemy subscription test B",
    });
    const association =
      target === "none"
        ? undefined
        : yield* Azure.Management.ManagementGroupSubscription("Subscription", {
            managementGroupId:
              target === "A" ? a.managementGroupId : b.groupName,
          });
    return { a, b, association };
  });

test.provider.skipIf(!runSubscriptionMove)(
  "move the subscription under a management group and back",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { subscriptionId, tenantId } =
        yield* Azure.AzureEnvironment.current;

      const first = yield* stack.deploy(program("A"));
      expect(first.association?.subscriptionId).toEqual(subscriptionId);
      expect(first.association?.groupName).toEqual(first.a.groupName);
      expect(first.association?.associationId).toContain(
        `/managementGroups/${first.a.groupName}/subscriptions/${subscriptionId}`,
      );
      expect(
        yield* parentOf(first.a.groupName, subscriptionId).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (parent) => parent === first.a.groupName,
            times: 24,
          }),
        ),
      ).toEqual(first.a.groupName);

      // Changing the group replaces the association: the subscription moves
      // to B, and the stale association under A must not move it back.
      const second = yield* stack.deploy(program("B"));
      expect(second.association?.groupName).toEqual(first.b.groupName);
      expect(
        yield* parentOf(first.b.groupName, subscriptionId).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (parent) => parent === first.b.groupName,
            times: 24,
          }),
        ),
      ).toEqual(first.b.groupName);

      // Deleting the association returns the subscription to the root
      // (read through B, which the deploying identity can read).
      yield* stack.deploy(program("none"));
      expect(
        yield* parentOf(first.b.groupName, subscriptionId).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (parent) => parent === tenantId,
            times: 24,
          }),
        ),
      ).toEqual(tenantId);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:management", "live"],
    timeout: 900_000,
  },
);
