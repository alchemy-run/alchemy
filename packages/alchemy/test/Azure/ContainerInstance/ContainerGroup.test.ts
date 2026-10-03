import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as aci from "@distilled.cloud/azure/containerinstance";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getGroup = (resourceGroupName: string, containerGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* aci.GetContainerGroup({
      subscriptionId,
      resourceGroupName,
      containerGroupName,
    });
  });

const groupGone = (resourceGroupName: string, containerGroupName: string) =>
  getGroup(resourceGroupName, containerGroupName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: {
  greeting: string;
  restartPolicy: "Always" | "OnFailure";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const web = yield* Azure.ContainerInstance.ContainerGroup("Web", {
      resourceGroup: group.resourceGroupName,
      restartPolicy: props.restartPolicy,
      containers: [
        {
          name: "web",
          image: "mcr.microsoft.com/azuredocs/aci-helloworld",
          cpu: 0.5,
          memoryInGB: 0.5,
          ports: [{ port: 80 }],
          environment: { GREETING: props.greeting },
        },
      ],
      ipAddress: { type: "Public", ports: [{ port: 80, protocol: "TCP" }] },
      tags: props.tags,
    });
    return { group, web };
  });

// ~0.5 vCPU / 0.5 GB for a few minutes: well under $0.05 per run.
test.provider(
  "create, update, replace, and delete a container group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, web } = yield* stack.deploy(
        program({
          greeting: "hello",
          restartPolicy: "Always",
          tags: { env: "test" },
        }),
      );
      expect(web.containerGroupName).toMatch(/^[a-z][a-z0-9-]{0,62}$/);
      expect(web.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      const observed = yield* getGroup(
        group.resourceGroupName,
        web.containerGroupName,
      );
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.restartPolicy).toEqual("Always");
      expect(observed.tags?.env).toEqual("test");
      expect(
        observed.properties.containers[0]?.properties.environmentVariables,
      ).toEqual([{ name: "GREETING", value: "hello" }]);

      // In place: env var re-deploys the group, tags PATCH it.
      const updated = yield* stack.deploy(
        program({
          greeting: "bonjour",
          restartPolicy: "Always",
          tags: { env: "prod" },
        }),
      );
      expect(updated.web.containerGroupId).toEqual(web.containerGroupId);
      const reobserved = yield* getGroup(
        group.resourceGroupName,
        web.containerGroupName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(
        reobserved.properties.containers[0]?.properties.environmentVariables,
      ).toEqual([{ name: "GREETING", value: "bonjour" }]);

      // A restart policy change replaces the group with a new physical name.
      const replaced = yield* stack.deploy(
        program({
          greeting: "bonjour",
          restartPolicy: "OnFailure",
          tags: { env: "prod" },
        }),
      );
      const afterReplace = yield* getGroup(
        group.resourceGroupName,
        replaced.web.containerGroupName,
      );
      expect(afterReplace.properties.restartPolicy).toEqual("OnFailure");
      expect(afterReplace.properties.provisioningState).toEqual("Succeeded");
      expect(replaced.web.containerGroupName).not.toEqual(
        web.containerGroupName,
      );
      expect(
        yield* groupGone(group.resourceGroupName, web.containerGroupName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* groupGone(
          group.resourceGroupName,
          replaced.web.containerGroupName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerinstance", "live"],
    timeout: 900_000,
  },
);
