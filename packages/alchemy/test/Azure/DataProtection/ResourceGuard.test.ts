import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dataprotection from "@distilled.cloud/azure/dataprotection";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const STOP_PROTECTION =
  "Microsoft.DataProtection/backupVaults/backupInstances/stopProtection/action";
const INSTANCE_DELETE =
  "Microsoft.DataProtection/backupVaults/backupInstances/delete";

const getGuard = (resourceGroupName: string, resourceGuardsName: string) =>
  Effect.gen(function* () {
    return yield* dataprotection.GetResourceGuard({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceGuardsName,
    });
  });

const program = (props: {
  exclusions: string[];
  tags: Record<string, string>;
  location?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const guard = yield* Azure.DataProtection.ResourceGuard("Guard", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      vaultCriticalOperationExclusionList: props.exclusions,
      tags: props.tags,
    });
    return { group, guard };
  });

// Resource guard: $0, seconds to create.
test.provider(
  "create, update, replace, and delete a resource guard",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, guard } = yield* stack.deploy(
        program({ exclusions: [STOP_PROTECTION], tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(guard.resourceGuardId).toContain("/resourceGuards/");
      expect(guard.vaultCriticalOperationExclusionList).toEqual([
        STOP_PROTECTION,
      ]);
      expect(guard.resourceGuardOperations.length).toBeGreaterThan(0);
      const observed = yield* getGuard(rg, guard.resourceGuardName);
      expect(observed.properties?.vaultCriticalOperationExclusionList).toEqual([
        STOP_PROTECTION,
      ]);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Guard");

      // In-place update: exclusion list and tags.
      const updated = yield* stack.deploy(
        program({
          exclusions: [STOP_PROTECTION, INSTANCE_DELETE],
          tags: { env: "prod" },
        }),
      );
      expect(updated.guard.resourceGuardName).toEqual(guard.resourceGuardName);
      const reobserved = yield* getGuard(rg, guard.resourceGuardName);
      expect(
        [...(reobserved.properties?.vaultCriticalOperationExclusionList ?? [])]
          .map((s) => s.toLowerCase())
          .sort(),
      ).toEqual(
        [INSTANCE_DELETE, STOP_PROTECTION].map((s) => s.toLowerCase()).sort(),
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: location is immutable.
      const replaced = yield* stack.deploy(
        program({
          exclusions: [STOP_PROTECTION],
          tags: { env: "prod" },
          location: "westus2",
        }),
      );
      expect(replaced.guard.resourceGuardName).not.toEqual(
        guard.resourceGuardName,
      );
      expect(replaced.guard.location).toEqual("westus2");
      expect(yield* waitGone(getGuard(rg, guard.resourceGuardName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(getGuard(rg, replaced.guard.resourceGuardName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
