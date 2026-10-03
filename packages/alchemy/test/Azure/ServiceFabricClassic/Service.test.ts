import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as servicefabric from "@distilled.cloud/azure/servicefabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, readyCluster, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getService = (
  resourceGroupName: string,
  clusterName: string,
  applicationName: string,
  serviceName: string,
) =>
  Effect.gen(function* () {
    return yield* servicefabric.GetService({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      applicationName,
      serviceName,
    });
  });

const program = (props: {
  instanceCount: number;
  tags: Record<string, string>;
  name?: string;
}) =>
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
      typeName: appType.applicationTypeName,
      typeVersion: version.version,
    });
    const service = yield* Azure.ServiceFabricClassic.Service("Service", {
      resourceGroup: target.resourceGroup,
      cluster: target.cluster,
      application: app.applicationName,
      name: props.name,
      serviceKind: "Stateless",
      serviceTypeName: target.serviceTypeName,
      instanceCount: props.instanceCount,
      partitionDescription: { partitionScheme: "Singleton" },
      tags: props.tags,
    });
    return { app, service };
  });

// Needs a Ready classic cluster (20-30 min to build, ~$0.10/h) — see
// `readyCluster`.
test.provider.skipIf(!runExpensive || readyCluster === undefined)(
  "create, update, replace, and delete a classic service fabric service",
  (stack) =>
    Effect.gen(function* () {
      const target = readyCluster!;
      yield* stack.destroy();

      const { app, service } = yield* stack.deploy(
        program({ instanceCount: 1, tags: { env: "test" } }),
      );
      expect(service.serviceName.startsWith(`${app.applicationName}~`)).toBe(
        true,
      );
      expect(service.serviceKind).toEqual("Stateless");
      const observed = yield* getService(
        target.resourceGroup,
        target.cluster,
        app.applicationName,
        service.serviceName,
      );
      expect(observed.properties?.instanceCount).toEqual(1);

      // In-place: instance count and tags (PATCH).
      const updated = yield* stack.deploy(
        program({ instanceCount: -1, tags: { env: "prod" } }),
      );
      expect(updated.service.serviceId).toEqual(service.serviceId);
      const after = yield* getService(
        target.resourceGroup,
        target.cluster,
        app.applicationName,
        service.serviceName,
      );
      expect(after.properties?.instanceCount).toEqual(-1);
      expect(after.tags?.env).toEqual("prod");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({ instanceCount: -1, tags: { env: "prod" }, name: "Renamed" }),
      );
      expect(replaced.service.serviceName).toEqual(
        `${app.applicationName}~Renamed`,
      );
      expect(
        yield* waitGone(
          getService(
            target.resourceGroup,
            target.cluster,
            app.applicationName,
            service.serviceName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getService(
            target.resourceGroup,
            target.cluster,
            app.applicationName,
            replaced.service.serviceName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
