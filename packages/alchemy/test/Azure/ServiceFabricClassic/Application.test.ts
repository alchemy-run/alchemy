import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as servicefabric from "@distilled.cloud/azure/servicefabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, readyCluster, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getApplication = (
  resourceGroupName: string,
  clusterName: string,
  applicationName: string,
) =>
  Effect.gen(function* () {
    return yield* servicefabric.GetApplication({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      applicationName,
    });
  });

const program = (props: { tags: Record<string, string>; name?: string }) =>
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
      },
    );
    const app = yield* Azure.ServiceFabricClassic.Application("App", {
      resourceGroup: target.resourceGroup,
      cluster: target.cluster,
      name: props.name,
      typeName: appType.applicationTypeName,
      typeVersion: version.version,
      upgradePolicy: { upgradeMode: "UnmonitoredAuto" },
      tags: props.tags,
    });
    return { app };
  });

// Needs a Ready classic cluster (20-30 min to build, ~$0.10/h) — see
// `readyCluster`. On a `WaitingForNodes` cluster ARM rejects the
// application: "<version> not usable while provisioning state is Updating".
test.provider.skipIf(!runExpensive || readyCluster === undefined)(
  "create, update, replace, and delete a classic service fabric application",
  (stack) =>
    Effect.gen(function* () {
      const target = readyCluster!;
      yield* stack.destroy();

      const { app } = yield* stack.deploy(program({ tags: { env: "test" } }));
      expect(app.provisioningState).toEqual("Succeeded");
      expect(app.typeName).toEqual(target.typeName);
      expect(app.typeVersion).toEqual(target.typeVersion);

      // In-place: tags (PATCH).
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.app.applicationId).toEqual(app.applicationId);
      expect(
        (yield* getApplication(
          target.resourceGroup,
          target.cluster,
          app.applicationName,
        )).tags?.env,
      ).toEqual("prod");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({ tags: { env: "prod" }, name: "alchemyrenamed" }),
      );
      expect(replaced.app.applicationName).toEqual("alchemyrenamed");
      expect(
        yield* waitGone(
          getApplication(
            target.resourceGroup,
            target.cluster,
            app.applicationName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getApplication(target.resourceGroup, target.cluster, "alchemyrenamed"),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
