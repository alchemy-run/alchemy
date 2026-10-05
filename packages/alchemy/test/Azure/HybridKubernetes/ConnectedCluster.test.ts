import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hk from "@distilled.cloud/azure/hybridkubernetes";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { AGENT_PUBLIC_KEY_A, AGENT_PUBLIC_KEY_B } from "./fixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getCluster = (resourceGroupName: string, clusterName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* hk.GetConnectedCluster({
      subscriptionId,
      resourceGroupName,
      clusterName,
    });
  });

const clusterGone = (resourceGroupName: string, clusterName: string) =>
  getCluster(resourceGroupName, clusterName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 36,
    }),
  );

const program = (props: {
  agentPublicKeyCertificate: string;
  distribution: string;
  distributionVersion: string;
  oidcIssuer: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cluster = yield* Azure.HybridKubernetes.ConnectedCluster("Edge", {
      resourceGroup: group.resourceGroupName,
      agentPublicKeyCertificate: props.agentPublicKeyCertificate,
      distribution: props.distribution,
      distributionVersion: props.distributionVersion,
      infrastructure: "generic",
      oidcIssuerProfile: props.oidcIssuer ? { enabled: true } : undefined,
      tags: props.tags,
    });
    return { group, cluster };
  });

// Free: an ARM-only registration whose Arc agents never connect.
test.provider(
  "create, update, replace, and delete a connected cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster } = yield* stack.deploy(
        program({
          agentPublicKeyCertificate: AGENT_PUBLIC_KEY_A,
          distribution: "k3s",
          distributionVersion: "1.30",
          oidcIssuer: false,
          tags: { env: "test" },
        }),
      );
      expect(cluster.clusterName).toMatch(/^[A-Za-z0-9][-_A-Za-z0-9]{0,62}$/);
      expect(cluster.identityType).toEqual("SystemAssigned");
      expect(cluster.principalId).toBeDefined();
      expect(cluster.agentPublicKeyCertificate).toEqual(AGENT_PUBLIC_KEY_A);
      expect(cluster.tags).toEqual({ env: "test" });

      const observed = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.distribution).toEqual("k3s");
      expect(observed.properties.infrastructure).toEqual("generic");
      expect(observed.properties.distributionVersion).toEqual("1.30");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Edge");

      // In place: distribution and the OIDC issuer go through PUT, the
      // distribution version and tags through PATCH.
      const updated = yield* stack.deploy(
        program({
          agentPublicKeyCertificate: AGENT_PUBLIC_KEY_A,
          distribution: "kind",
          distributionVersion: "1.31",
          oidcIssuer: true,
          tags: { env: "prod" },
        }),
      );
      expect(updated.cluster.clusterId).toEqual(cluster.clusterId);
      const reobserved = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(reobserved.properties.distribution).toEqual("kind");
      expect(reobserved.properties.distributionVersion).toEqual("1.31");
      expect(reobserved.properties.oidcIssuerProfile?.enabled).toEqual(true);
      expect(updated.cluster.oidcIssuerUrl).toMatch(/^https:\/\//);
      expect(reobserved.tags?.env).toEqual("prod");

      // PATCH-only delta: distribution version and tags.
      const patched = yield* stack.deploy(
        program({
          agentPublicKeyCertificate: AGENT_PUBLIC_KEY_A,
          distribution: "kind",
          distributionVersion: "1.32",
          oidcIssuer: true,
          tags: { env: "stage" },
        }),
      );
      expect(patched.cluster.clusterId).toEqual(cluster.clusterId);
      const repatched = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(repatched.properties.distributionVersion).toEqual("1.32");
      expect(repatched.properties.oidcIssuerProfile?.enabled).toEqual(true);
      expect(repatched.tags?.env).toEqual("stage");

      // A new agent key replaces the registration.
      const replaced = yield* stack.deploy(
        program({
          agentPublicKeyCertificate: AGENT_PUBLIC_KEY_B,
          distribution: "kind",
          distributionVersion: "1.32",
          oidcIssuer: true,
          tags: { env: "stage" },
        }),
      );
      expect(replaced.cluster.clusterName).not.toEqual(cluster.clusterName);
      expect(replaced.cluster.agentPublicKeyCertificate).toEqual(
        AGENT_PUBLIC_KEY_B,
      );
      const fresh = yield* getCluster(
        group.resourceGroupName,
        replaced.cluster.clusterName,
      );
      expect(fresh.properties.agentPublicKeyCertificate).toEqual(
        AGENT_PUBLIC_KEY_B,
      );
      expect(
        yield* clusterGone(group.resourceGroupName, cluster.clusterName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* clusterGone(
          group.resourceGroupName,
          replaced.cluster.clusterName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:hybridkubernetes", "live"],
    timeout: 900_000,
  },
);
