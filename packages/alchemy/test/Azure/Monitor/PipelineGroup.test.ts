import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as monitoringservice from "@distilled.cloud/azure/monitoringservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * A pipeline group runs on an Azure Arc-enabled Kubernetes cluster with
 * the Azure Monitor pipeline extension and a custom location — external
 * onboarding the free-trial test subscription does not have. The full
 * lifecycle runs only with `AZURE_TEST_PAID=1` plus the custom location's
 * ARM ID in `AZURE_TEST_CUSTOM_LOCATION_ID` (and its region in
 * `AZURE_TEST_CUSTOM_LOCATION_REGION`). The cluster itself costs roughly
 * $5+/day; the pipeline group adds no Azure charge.
 */
const customLocationId = process.env.AZURE_TEST_CUSTOM_LOCATION_ID;
const customLocationRegion =
  process.env.AZURE_TEST_CUSTOM_LOCATION_REGION ?? "eastus";

const getPipelineGroup = (
  resourceGroupName: string,
  pipelineGroupName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* monitoringservice.GetPipelineGroup({
      subscriptionId,
      resourceGroupName,
      pipelineGroupName,
    });
  });

const pipelineGroupGone = (resourceGroupName: string, name: string) =>
  getPipelineGroup(resourceGroupName, name).pipe(
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

const otlpOnly = (endpoint: string) => ({
  receivers: [{ type: "OTLP" as const, name: "otlp", otlp: { endpoint } }],
  exporters: [
    {
      type: "AzureMonitorWorkspaceLogs" as const,
      name: "logs",
      azureMonitorWorkspaceLogs: {
        api: {
          dataCollectionEndpointUrl:
            "https://example.eastus-1.ingest.monitor.azure.com",
          dataCollectionRule: "dcr-00000000000000000000000000000000",
          stream: "Custom-Otlp",
          schema: { recordMap: [{ from: "body", to: "Body" }] },
        },
      },
    },
  ],
  service: {
    pipelines: [
      {
        name: "logs",
        type: "Logs" as const,
        receivers: ["otlp"],
        exporters: ["logs"],
      },
    ],
  },
});

test.provider(
  "pipeline group with a missing custom location is rejected with CustomLocationNotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const result = yield* monitoringservice
        .PipelineGroupsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          pipelineGroupName: "alchemy-probe",
          location: "eastus",
          extendedLocation: {
            name: `/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.ExtendedLocation/customLocations/missing`,
            type: "CustomLocation",
          },
          properties: { ...otlpOnly("0.0.0.0:4317"), processors: [] },
        })
        .pipe(
          Effect.as("created" as const),
          Effect.catchTag("CustomLocationNotFound", () =>
            Effect.succeed("CustomLocationNotFound" as const),
          ),
        );
      expect(result).toEqual("CustomLocationNotFound");
      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:monitor", "live"],
    timeout: 300_000,
  },
);

const program = (props: {
  endpoint: string;
  replicas: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: customLocationRegion,
    });
    const pipeline = yield* Azure.Monitor.PipelineGroup("Pipeline", {
      resourceGroup: group.resourceGroupName,
      location: customLocationRegion,
      customLocationId: customLocationId!,
      replicas: props.replicas,
      ...otlpOnly(props.endpoint),
      tags: props.tags,
    });
    return { group, pipeline };
  });

test.provider.skipIf(!runPaidOnly || !customLocationId)(
  "create, update, and delete an Azure Monitor pipeline group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          endpoint: "0.0.0.0:4317",
          replicas: 1,
          tags: { env: "test" },
        }),
      );
      const rg = created.group.resourceGroupName;
      const name = created.pipeline.pipelineGroupName;
      expect(created.pipeline.customLocationId.toLowerCase()).toEqual(
        customLocationId!.toLowerCase(),
      );
      const observed = yield* getPipelineGroup(rg, name);
      expect(observed.properties?.replicas).toEqual(1);
      expect(observed.tags?.env).toEqual("test");

      // In-place update: replicas, receiver endpoint, and tags.
      yield* stack.deploy(
        program({
          endpoint: "0.0.0.0:4318",
          replicas: 2,
          tags: { env: "prod" },
        }),
      );
      const updated = yield* getPipelineGroup(rg, name);
      expect(updated.properties?.replicas).toEqual(2);
      expect(updated.properties?.receivers[0]?.otlp?.endpoint).toEqual(
        "0.0.0.0:4318",
      );
      expect(updated.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* pipelineGroupGone(rg, name)).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:monitor", "live"],
    timeout: 900_000,
  },
);
