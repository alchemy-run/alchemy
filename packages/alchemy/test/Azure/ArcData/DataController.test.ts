import * as Azure from "@/Azure";
import type * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as arcdata from "@distilled.cloud/azure/azurearcdata";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { signingCertificate } from "./fixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:arcdata", "live"];

const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

const getController = (resourceGroupName: string, dataControllerName: string) =>
  Effect.gen(function* () {
    return yield* arcdata.GetDataControllerDataController({
      subscriptionId: yield* subscription,
      resourceGroupName,
      dataControllerName,
    });
  });

const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

/** Minimal `DataController` custom resource, as `az arcdata dc export` emits. */
const dataControllerCr = (
  logsRetentionDays: number,
  azure: { subscription: string; resourceGroup: Output.Output<string> },
) => ({
  apiVersion: "arcdata.microsoft.com/v5",
  kind: "DataController",
  metadata: { name: "arc-dc", namespace: "arc" },
  spec: {
    infrastructure: "other",
    credentials: {
      controllerAdmin: "controller-login-secret",
      serviceAccount: "sa-arc-controller",
    },
    docker: {
      registry: "mcr.microsoft.com",
      repository: "arcdata",
      imageTag: "v1.38.0_2025-04-08",
      imagePullPolicy: "Always",
    },
    security: { allowRunAsRoot: false },
    services: [
      { name: "controller", port: 30080, serviceType: "LoadBalancer" },
    ],
    settings: {
      azure: {
        connectionMode: "indirect",
        location: "eastus",
        resourceGroup: azure.resourceGroup,
        subscription: azure.subscription,
      },
      controller: { "logs.rotation.days": String(logsRetentionDays) },
    },
    storage: {
      data: { accessMode: "ReadWriteOnce", className: "default", size: "15Gi" },
      logs: { accessMode: "ReadWriteOnce", className: "default", size: "10Gi" },
    },
  },
});

const program = (props: {
  clusterId: string;
  infrastructure: Azure.ArcData.DataControllerInfrastructure;
  tags: Record<string, string>;
  logsRetentionDays: number;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const controller = yield* Azure.ArcData.DataController("Controller", {
      resourceGroup: group.resourceGroupName,
      infrastructure: props.infrastructure,
      onPremiseProperty: {
        id: props.clusterId,
        publicSigningKey: signingCertificate,
      },
      k8sRaw: dataControllerCr(props.logsRetentionDays, {
        subscription: yield* subscription,
        resourceGroup: group.resourceGroupName,
      }),
      tags: props.tags,
    });
    return { group, controller };
  });

const clusterA = "4f9d2c61-3b8e-4c1a-9a57-2e6f0b7d1c01";
const clusterB = "4f9d2c61-3b8e-4c1a-9a57-2e6f0b7d1c02";

// Indirect-mode data controller: a free ARM registration (billing only
// accrues for SQL MI / PostgreSQL vCores uploaded from a cluster); creates
// in seconds.
test.provider(
  "create, update, replace, and delete an indirect-mode data controller",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, controller } = yield* stack.deploy(
        program({
          clusterId: clusterA,
          infrastructure: "other",
          tags: { env: "test" },
          logsRetentionDays: 7,
        }),
      );
      const get = (name: string) =>
        getController(group.resourceGroupName, name);
      expect(controller.dataControllerId).toContain(
        "/providers/Microsoft.AzureArcData/dataControllers/",
      );
      const observed = yield* get(controller.dataControllerName);
      expect(observed.properties.infrastructure).toEqual("other");
      expect(observed.properties.onPremiseProperty?.id).toEqual(clusterA);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Controller");

      // In-place: infrastructure and tags.
      const updated = yield* stack.deploy(
        program({
          clusterId: clusterA,
          infrastructure: "onpremises",
          tags: { env: "prod" },
          logsRetentionDays: 14,
        }),
      );
      expect(updated.controller.dataControllerId).toEqual(
        controller.dataControllerId,
      );
      expect(updated.controller.tags).toEqual({ env: "prod" });
      const reobserved = yield* get(controller.dataControllerName);
      expect(reobserved.properties.infrastructure).toEqual("onpremises");
      expect(reobserved.tags?.env).toEqual("prod");
      expect(
        (reobserved.properties.k8sRaw as ReturnType<typeof dataControllerCr>)
          .spec.settings.controller["logs.rotation.days"],
      ).toEqual("14");

      // Replacement: the cluster identity is immutable.
      const replaced = yield* stack.deploy(
        program({
          clusterId: clusterB,
          infrastructure: "onpremises",
          tags: { env: "prod" },
          logsRetentionDays: 14,
        }),
      );
      expect(replaced.controller.dataControllerName).not.toEqual(
        controller.dataControllerName,
      );
      const replacedObserved = yield* get(
        replaced.controller.dataControllerName,
      );
      expect(replacedObserved.properties.onPremiseProperty?.id).toEqual(
        clusterB,
      );
      expect(yield* waitGone(get(controller.dataControllerName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.controller.dataControllerName)),
      ).toEqual("gone");
    }),
  { tags, timeout: 600_000 },
);
