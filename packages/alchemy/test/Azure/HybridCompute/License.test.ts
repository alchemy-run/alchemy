import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getLicense = (resourceGroupName: string, licenseName: string) =>
  Effect.gen(function* () {
    return yield* hybridcompute.GetLicense({
      subscriptionId: yield* subscription,
      resourceGroupName,
      licenseName,
    });
  });

const program = (props: {
  target: Azure.HybridCompute.LicenseTarget;
  edition: Azure.HybridCompute.LicenseEdition;
  coreType?: Azure.HybridCompute.LicenseCoreType;
  processors: number;
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Never activate in tests: activation bills the full ESU term.
    const license = yield* Azure.HybridCompute.License("License", {
      resourceGroup: group.resourceGroupName,
      state: "Deactivated",
      ...props,
      coreType: props.coreType ?? "vCore",
    });
    return { group, license };
  });

// A deactivated license is free; seconds.
test.provider(
  "create, update, replace, and delete a license",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, license } = yield* stack.deploy(
        program({
          target: "Windows Server 2012",
          edition: "Standard",
          processors: 8,
        }),
      );
      const rg = group.resourceGroupName;
      expect(license.state).toEqual("Deactivated");
      const observed = yield* getLicense(rg, license.licenseName);
      expect(observed.properties?.licenseDetails?.processors).toEqual(8);
      expect(observed.properties?.licenseDetails?.edition).toEqual("Standard");
      expect(observed.tags?.["alchemy::id"]).toEqual("License");

      // In-place: more cores and a tag.
      const updated = yield* stack.deploy(
        program({
          target: "Windows Server 2012",
          edition: "Standard",
          processors: 16,
          tags: { env: "test" },
        }),
      );
      expect(updated.license.licenseId).toEqual(license.licenseId);
      const reobserved = yield* getLicense(rg, license.licenseName);
      expect(reobserved.properties?.licenseDetails?.processors).toEqual(16);
      expect(reobserved.properties?.licenseDetails?.edition).toEqual(
        "Standard",
      );
      expect(reobserved.properties?.licenseDetails?.state).toEqual(
        "Deactivated",
      );
      expect(reobserved.tags?.env).toEqual("test");

      // Replacement: target, edition, and core type are immutable.
      const replaced = yield* stack.deploy(
        program({
          target: "Windows Server 2012 R2",
          edition: "Datacenter",
          coreType: "pCore",
          processors: 16,
          tags: { env: "test" },
        }),
      );
      expect(replaced.license.target).toEqual("Windows Server 2012 R2");
      expect(replaced.license.immutableId).not.toEqual(license.immutableId);
      const replacedObserved = yield* getLicense(
        rg,
        replaced.license.licenseName,
      );
      expect(replacedObserved.properties?.licenseDetails?.target).toEqual(
        "Windows Server 2012 R2",
      );
      expect(replacedObserved.properties?.licenseDetails?.edition).toEqual(
        "Datacenter",
      );
      expect(yield* waitGone(getLicense(rg, license.licenseName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(getLicense(rg, replaced.license.licenseName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
