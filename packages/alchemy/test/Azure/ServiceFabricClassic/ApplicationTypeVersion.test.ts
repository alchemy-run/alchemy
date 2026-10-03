import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as servicefabric from "@distilled.cloud/azure/servicefabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, readyCluster, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVersion = (
  resourceGroupName: string,
  clusterName: string,
  applicationTypeName: string,
  version: string,
) =>
  Effect.gen(function* () {
    return yield* servicefabric.GetApplicationTypeVersion({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      applicationTypeName,
      version,
    });
  });

const program = (versionTags: Record<string, string>) =>
  Effect.gen(function* () {
    const target = readyCluster!;
    const appType = yield* Azure.ServiceFabricClassic.ApplicationType(
      "AppType",
      {
        resourceGroup: target.resourceGroup,
        cluster: target.cluster,
        name: target.typeName,
      },
    );
    const version = yield* Azure.ServiceFabricClassic.ApplicationTypeVersion(
      "Version",
      {
        resourceGroup: target.resourceGroup,
        cluster: target.cluster,
        applicationType: appType.applicationTypeName,
        version: target.typeVersion,
        appPackageUrl: target.packageUrl,
        tags: versionTags,
      },
    );
    return { appType, version };
  });

// Needs a Ready classic cluster (20-30 min to build: node scale set, Key
// Vault certificate, ~$0.10/h for a 1-node Standard_B2s) — see `readyCluster`.
// On a `WaitingForNodes` cluster the version is accepted but stays
// `Updating` forever.
test.provider.skipIf(!runExpensive || readyCluster === undefined)(
  "create, update, and delete a classic service fabric application type version",
  (stack) =>
    Effect.gen(function* () {
      const target = readyCluster!;
      yield* stack.destroy();

      const { version } = yield* stack.deploy(program({ env: "test" }));
      expect(version.provisioningState).toEqual("Succeeded");
      expect(version.appPackageUrl).toEqual(target.packageUrl);
      const observed = yield* getVersion(
        target.resourceGroup,
        target.cluster,
        target.typeName,
        target.typeVersion,
      );
      expect(observed.tags?.env).toEqual("test");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ env: "prod" }));
      expect(updated.version.applicationTypeVersionId).toEqual(
        version.applicationTypeVersionId,
      );
      expect(
        (yield* getVersion(
          target.resourceGroup,
          target.cluster,
          target.typeName,
          target.typeVersion,
        )).tags?.env,
      ).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getVersion(
            target.resourceGroup,
            target.cluster,
            target.typeName,
            target.typeVersion,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
