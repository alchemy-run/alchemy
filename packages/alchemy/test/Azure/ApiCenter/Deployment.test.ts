import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apicenter from "@distilled.cloud/azure/apicenter";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  apiCenter,
  logLevel,
  openApi,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name: string; runtimeUri: string }) =>
  Effect.gen(function* () {
    const { group, center } = yield* apiCenter;
    const api = yield* Azure.ApiCenter.Api("Orders", {
      resourceGroup: group.resourceGroupName,
      serviceName: center.serviceName,
      name: "orders",
      title: "Orders API",
      kind: "rest",
    });
    const version = yield* Azure.ApiCenter.ApiVersion("V1", {
      resourceGroup: group.resourceGroupName,
      serviceName: center.serviceName,
      apiName: api.apiName,
      name: "v1",
      lifecycleStage: "production",
    });
    const definition = yield* Azure.ApiCenter.ApiDefinition("OpenApi", {
      resourceGroup: group.resourceGroupName,
      serviceName: center.serviceName,
      apiName: api.apiName,
      versionName: version.versionName,
      name: "openapi",
      specification: { name: "openapi", value: openApi("Orders") },
    });
    const environment = yield* Azure.ApiCenter.Environment("Prod", {
      resourceGroup: group.resourceGroupName,
      serviceName: center.serviceName,
      name: "prod",
      kind: "production",
    });
    const deployment = yield* Azure.ApiCenter.Deployment("OrdersProd", {
      resourceGroup: group.resourceGroupName,
      serviceName: center.serviceName,
      apiName: api.apiName,
      name: props.name,
      title: "Orders (production)",
      environmentId: environment.scopedId,
      definitionId: definition.scopedId,
      runtimeUri: [props.runtimeUri],
    });
    return { group, center, deployment };
  });

// Free-plan API Center: $0, provisions in under a minute.
test.provider(
  "create, update, replace, and delete an API deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, center, deployment } = yield* stack.deploy(
        program({ name: "prod", runtimeUri: "https://api.example.com/orders" }),
      );
      expect(deployment.deploymentName).toEqual("prod");
      const get = (name: string) =>
        Effect.gen(function* () {
          return yield* apicenter.GetDeployment({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            serviceName: center.serviceName,
            workspaceName: "default",
            apiName: "orders",
            deploymentName: name,
          });
        });
      const observed = yield* get("prod");
      expect(observed.properties?.environmentId?.toLowerCase()).toEqual(
        "/workspaces/default/environments/prod",
      );
      expect(observed.properties?.definitionId?.toLowerCase()).toEqual(
        "/workspaces/default/apis/orders/versions/v1/definitions/openapi",
      );
      expect(observed.properties?.server?.runtimeUri).toEqual([
        "https://api.example.com/orders",
      ]);

      // In-place: runtime URL.
      const updated = yield* stack.deploy(
        program({ name: "prod", runtimeUri: "https://api.example.com/v2" }),
      );
      expect(updated.deployment.deploymentId).toEqual(deployment.deploymentId);
      expect((yield* get("prod")).properties?.server?.runtimeUri).toEqual([
        "https://api.example.com/v2",
      ]);

      // Replacement: rename.
      const replaced = yield* stack.deploy(
        program({ name: "production", runtimeUri: "https://api.example.com/v2" }),
      );
      expect(replaced.deployment.deploymentName).toEqual("production");
      expect((yield* get("production")).name).toEqual("production");
      expect(yield* waitGone(get("prod"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("production"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
