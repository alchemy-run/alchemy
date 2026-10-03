import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as desktopvirtualization from "@distilled.cloud/azure/desktopvirtualization";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPackage = (resourceGroupName: string, appAttachPackageName: string) =>
  Effect.gen(function* () {
    return yield* desktopvirtualization.GetAppAttachPackage({
      subscriptionId: yield* subscription,
      resourceGroupName,
      appAttachPackageName,
    });
  });

const image = (
  version: string,
): Azure.DesktopVirtualization.AppAttachPackageImage => ({
  imagePath: "\\\\alchemytest.file.core.windows.net\\apps\\notepadpp.cim",
  packageName: "NotepadPlusPlus",
  packageFamilyName: "NotepadPlusPlus_7njy0v32s6xk6",
  packageFullName: `NotepadPlusPlus_${version}_x64__7njy0v32s6xk6`,
  packageRelativePath: `\\NotepadPlusPlus_${version}_x64__7njy0v32s6xk6`,
  displayName: "Notepad++",
  version,
  isActive: true,
  isRegularRegistration: false,
  lastUpdated: "2026-01-01T00:00:00Z",
  packageApplications: [],
  packageDependencies: [],
  certificateName: "CN=Alchemy",
  certificateExpiry: "2030-01-01T00:00:00Z",
});

const program = (props: {
  name?: string;
  version: string;
  attach: boolean;
  failHealthCheckOnStagingFailure:
    | "Unhealthy"
    | "NeedsAssistance"
    | "DoNotFail";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const pool = yield* Azure.DesktopVirtualization.HostPool("Pool", {
      resourceGroup: group.resourceGroupName,
      location,
      hostPoolType: "Pooled",
      loadBalancerType: "BreadthFirst",
    });
    const pkg = yield* Azure.DesktopVirtualization.AppAttachPackage("Package", {
      resourceGroup: group.resourceGroupName,
      location,
      name: props.name,
      image: image(props.version),
      hostPoolIds: props.attach ? [pool.hostPoolId] : [],
      failHealthCheckOnStagingFailure: props.failHealthCheckOnStagingFailure,
      tags: props.tags,
    });
    return { group, pool, pkg };
  });

// App Attach packages are free metadata objects. The image path is never
// mounted because the host pool has no session hosts.
test.provider(
  "create, update, replace, and delete an app attach package",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, pool, pkg } = yield* stack.deploy(
        program({
          version: "8.6.0.0",
          attach: true,
          failHealthCheckOnStagingFailure: "NeedsAssistance",
          tags: { env: "test" },
        }),
      );
      const rg = group.resourceGroupName;
      const observed = yield* getPackage(rg, pkg.appAttachPackageName);
      expect(observed.properties.image?.version).toEqual("8.6.0.0");
      expect(
        observed.properties.hostPoolReferences?.map((id) => id.toLowerCase()),
      ).toEqual([pool.hostPoolId.toLowerCase()]);
      expect(observed.properties.failHealthCheckOnStagingFailure).toEqual(
        "NeedsAssistance",
      );
      expect(observed.tags?.env).toEqual("test");

      // In place: new package version, detach, health check policy, tags.
      const updated = yield* stack.deploy(
        program({
          version: "8.6.1.0",
          attach: false,
          failHealthCheckOnStagingFailure: "DoNotFail",
          tags: { env: "prod" },
        }),
      );
      expect(updated.pkg.appAttachPackageId).toEqual(pkg.appAttachPackageId);
      const reobserved = yield* getPackage(rg, pkg.appAttachPackageName);
      expect(reobserved.properties.image?.version).toEqual("8.6.1.0");
      expect(reobserved.properties.hostPoolReferences ?? []).toEqual([]);
      expect(reobserved.properties.failHealthCheckOnStagingFailure).toEqual(
        "DoNotFail",
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the package name is immutable.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-avd-test-pkg",
          version: "8.6.1.0",
          attach: false,
          failHealthCheckOnStagingFailure: "DoNotFail",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.pkg.appAttachPackageName).toEqual("alchemy-avd-test-pkg");
      const renamed = yield* getPackage(rg, "alchemy-avd-test-pkg");
      expect(renamed.properties.image?.version).toEqual("8.6.1.0");
      expect(yield* waitGone(getPackage(rg, pkg.appAttachPackageName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* waitGone(getPackage(rg, "alchemy-avd-test-pkg"))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
