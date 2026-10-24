import * as Azure from "@alchemy.run/azure";
import * as desktopvirtualization from "@distilled.cloud/azure/desktopvirtualization";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPackage = (resourceGroupName: string, hostPoolName: string, msixPackageFullName: string) =>
  Effect.gen(function* () {
    return yield* desktopvirtualization.GetMSIXPackage({
      subscriptionId: yield* subscription,
      resourceGroupName,
      hostPoolName,
      msixPackageFullName,
    });
  });

const ICON =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const fullName = (version: string) => `NotepadPlusPlus_${version}_x64__7njy0v32s6xk6`;

const program = (props: {
  version: string;
  displayName: string;
  isActive: boolean;
  isRegularRegistration: boolean;
  share: string;
  lastUpdated?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const pool = yield* Azure.DesktopVirtualization.HostPool("Pool", {
      resourceGroup: group.resourceGroupName,
      location,
      hostPoolType: "Pooled",
      loadBalancerType: "BreadthFirst",
    });
    const pkg = yield* Azure.DesktopVirtualization.MsixPackage("Package", {
      resourceGroup: group.resourceGroupName,
      hostPool: pool.hostPoolName,
      packageFullName: fullName(props.version),
      imagePath: `\\\\alchemytest.file.core.windows.net\\${props.share}\\notepadpp.vhdx`,
      packageName: "NotepadPlusPlus",
      packageFamilyName: "NotepadPlusPlus_7njy0v32s6xk6",
      packageRelativePath: `\\${fullName(props.version)}`,
      version: props.version,
      lastUpdated: props.lastUpdated ?? "2026-01-01T00:00:00Z",
      displayName: props.displayName,
      isActive: props.isActive,
      isRegularRegistration: props.isRegularRegistration,
      packageApplications: [
        {
          appId: "NotepadPlusPlus",
          appUserModelID: "NotepadPlusPlus_7njy0v32s6xk6!NotepadPlusPlus",
          friendlyName: "Notepad++",
          description: "Text editor",
          // Azure requires the icon; a 1x1 transparent PNG.
          iconImageName: "Square44x44Logo.png",
          rawIcon: ICON,
          rawPng: ICON,
        },
      ],
    });
    return { group, pool, pkg };
  });

// MSIX packages are free metadata objects on a free host pool. The image
// path is never mounted because the host pool has no session hosts.
test.provider(
  "create, update, replace, and delete an MSIX package",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, pool, pkg } = yield* stack.deploy(
        program({
          version: "8.6.0.0",
          displayName: "Notepad++",
          isActive: true,
          isRegularRegistration: false,
          share: "apps",
        }),
      );
      const rg = group.resourceGroupName;
      const hostPool = pool.hostPoolName;
      expect(pkg.packageFullName).toEqual(fullName("8.6.0.0"));
      expect(pkg.msixPackageId.toLowerCase()).toContain(
        `/hostpools/${hostPool.toLowerCase()}/msixpackages/`,
      );
      const observed = yield* getPackage(rg, hostPool, fullName("8.6.0.0"));
      expect(observed.properties.version).toEqual("8.6.0.0");
      expect(observed.properties.displayName).toEqual("Notepad++");
      expect(observed.properties.isActive).toEqual(true);
      expect(observed.properties.isRegularRegistration).toEqual(false);
      expect(observed.properties.packageApplications?.map((app) => app.appId)).toEqual([
        "NotepadPlusPlus",
      ]);

      // In place (PATCH): display name, active flag, registration mode.
      const patched = yield* stack.deploy(
        program({
          version: "8.6.0.0",
          displayName: "Notepad++ (staged)",
          isActive: false,
          isRegularRegistration: true,
          share: "apps",
        }),
      );
      expect(patched.pkg.msixPackageId).toEqual(pkg.msixPackageId);
      const reobserved = yield* getPackage(rg, hostPool, fullName("8.6.0.0"));
      expect(reobserved.properties.displayName).toEqual("Notepad++ (staged)");
      expect(reobserved.properties.isActive).toEqual(false);
      expect(reobserved.properties.isRegularRegistration).toEqual(true);

      // Replacement under the same name: Azure rejects a new image path.
      const reput = yield* stack.deploy(
        program({
          version: "8.6.0.0",
          displayName: "Notepad++ (staged)",
          isActive: false,
          isRegularRegistration: true,
          share: "apps-v2",
        }),
      );
      expect(reput.pkg.packageFullName).toEqual(fullName("8.6.0.0"));
      const reputObserved = yield* getPackage(rg, hostPool, fullName("8.6.0.0"));
      expect(reputObserved.properties.imagePath).toEqual(
        "\\\\alchemytest.file.core.windows.net\\apps-v2\\notepadpp.vhdx",
      );
      expect(reputObserved.properties.displayName).toEqual("Notepad++ (staged)");

      // Replacement under the same name: Azure rejects a new `lastUpdated`.
      const restamped = yield* stack.deploy(
        program({
          version: "8.6.0.0",
          displayName: "Notepad++ (staged)",
          isActive: false,
          isRegularRegistration: true,
          share: "apps-v2",
          lastUpdated: "2026-02-01T00:00:00Z",
        }),
      );
      expect(restamped.pkg.packageFullName).toEqual(fullName("8.6.0.0"));
      const restampedObserved = yield* getPackage(rg, hostPool, fullName("8.6.0.0"));
      expect(restampedObserved.properties.lastUpdated).toEqual("2026-02-01T00:00:00");

      // Replacement: a new version has a new package full name.
      const replaced = yield* stack.deploy(
        program({
          version: "8.6.1.0",
          displayName: "Notepad++",
          isActive: true,
          isRegularRegistration: false,
          share: "apps-v2",
        }),
      );
      expect(replaced.pkg.packageFullName).toEqual(fullName("8.6.1.0"));
      const renamed = yield* getPackage(rg, hostPool, fullName("8.6.1.0"));
      expect(renamed.properties.version).toEqual("8.6.1.0");
      expect(yield* waitGone(getPackage(rg, hostPool, fullName("8.6.0.0")))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getPackage(rg, hostPool, fullName("8.6.1.0")))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
