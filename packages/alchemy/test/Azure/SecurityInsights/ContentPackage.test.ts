import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { findProductPackage, packageProps } from "./catalog.ts";
import { pollGone, sentinelWorkspace, tags } from "./sentinel.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPackage = (
  resourceGroupName: string,
  workspaceName: string,
  packageId: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* securityinsights.GetContentPackage({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      packageId,
    });
  });

const packageGone = (rg: string, ws: string, id: string) =>
  pollGone(
    getPackage(rg, ws, id).pipe(
      Effect.as("found" as const),
      Effect.catchTag(
        ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
        () => Effect.succeed("gone" as const),
      ),
    ),
  );

type PackageProps = ReturnType<typeof packageProps>;

const program = (pkg?: PackageProps) =>
  Effect.gen(function* () {
    const { group, logs, sentinel } = yield* sentinelWorkspace;
    const installed = pkg
      ? yield* Azure.SecurityInsights.ContentPackage("Solution", {
          resourceGroup: sentinel.resourceGroup,
          workspace: sentinel.workspace,
          ...pkg,
        })
      : undefined;
    return { group, logs, installed };
  });

// Free Microsoft-published solutions on an empty Sentinel workspace: ~$0, ~4 minutes.
test.provider(
  "install, update, replace, and uninstall a Content Hub package",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bare = yield* stack.deploy(program());
      const rg = bare.group.resourceGroupName;
      const ws = bare.logs.workspaceName;
      const activity = packageProps(
        yield* findProductPackage(rg, ws, "Azure Activity"),
      );
      const keyVault = packageProps(
        yield* findProductPackage(rg, ws, "Azure Key Vault"),
      );

      const created = yield* stack.deploy(program(activity));
      expect(created.installed!.packageId).toEqual(activity.packageId);
      const observed = yield* getPackage(rg, ws, activity.packageId);
      expect(observed.properties?.version).toEqual(activity.version);
      expect(observed.properties?.contentKind).toEqual("Solution");

      // Re-installing in place with a changed display name.
      const renamed = { ...activity, displayName: "Azure Activity (Alchemy)" };
      yield* stack.deploy(program(renamed));
      const after = yield* getPackage(rg, ws, activity.packageId);
      expect(after.properties?.displayName).toEqual("Azure Activity (Alchemy)");

      // A different package ID replaces the installation.
      const replaced = yield* stack.deploy(program(keyVault));
      expect(replaced.installed!.packageId).toEqual(keyVault.packageId);
      expect(yield* packageGone(rg, ws, activity.packageId)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* packageGone(rg, ws, keyVault.packageId)).toEqual("gone");
    }),
  { tags, timeout: 900_000 },
);
