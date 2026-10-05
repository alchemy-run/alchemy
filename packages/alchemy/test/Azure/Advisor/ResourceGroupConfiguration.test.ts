import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as advisor from "@distilled.cloud/azure/advisor";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Azure.providers() });

/** Observed `exclude` of the group's `default` configuration. */
const observedExclude = (resourceGroup: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const listed = yield* advisor.ListConfigurationByResourceGroup({
      subscriptionId,
      resourceGroup,
    });
    const config = (listed.value ?? []).find(
      (entry) => entry.name?.toLowerCase() === "default",
    );
    return config?.properties?.exclude ?? false;
  });

const program = (opts: { group: string; exclude?: boolean } | undefined) =>
  Effect.gen(function* () {
    const groupA = yield* Azure.Resources.ResourceGroup("GroupA", {
      location: "eastus",
    });
    const groupB = yield* Azure.Resources.ResourceGroup("GroupB", {
      location: "eastus",
    });
    const config = opts
      ? yield* Azure.Advisor.ResourceGroupConfiguration("AdvisorConfig", {
          resourceGroup:
            opts.group === "A"
              ? groupA.resourceGroupName
              : groupB.resourceGroupName,
          exclude: opts.exclude,
        })
      : undefined;
    return { groupA, groupB, config };
  });

test.provider(
  "configure, update, replace, and reset a resource group Advisor configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create: exclude group A from Advisor.
      const created = yield* stack.deploy(
        program({ group: "A", exclude: true }),
      );
      const rgA = created.groupA.resourceGroupName;
      const rgB = created.groupB.resourceGroupName;
      expect(created.config!.exclude).toEqual(true);
      expect(created.config!.resourceGroup).toEqual(rgA);
      expect(created.config!.configurationId.toLowerCase()).toContain(
        `/resourcegroups/${rgA.toLowerCase()}/providers/microsoft.advisor/configurations/default`,
      );
      expect(yield* observedExclude(rgA)).toEqual(true);

      // In-place update: re-include group A.
      const updated = yield* stack.deploy(
        program({ group: "A", exclude: false }),
      );
      expect(updated.config!.exclude).toEqual(false);
      expect(yield* observedExclude(rgA)).toEqual(false);

      // Back to excluded, then replace onto group B: A is reset.
      yield* stack.deploy(program({ group: "A", exclude: true }));
      expect(yield* observedExclude(rgA)).toEqual(true);
      const replaced = yield* stack.deploy(
        program({ group: "B", exclude: true }),
      );
      expect(replaced.config!.resourceGroup).toEqual(rgB);
      expect(yield* observedExclude(rgB)).toEqual(true);
      expect(yield* observedExclude(rgA)).toEqual(false);

      // Removing the resource resets the configuration to the default.
      yield* stack.deploy(program(undefined));
      expect(yield* observedExclude(rgB)).toEqual(false);

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:advisor", "live"],
    timeout: 600_000,
  },
);
