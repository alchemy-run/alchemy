import * as Azure from "@/Azure";
import { resolveAzureCredentials } from "@/Azure/Credentials";
import { mintAccessToken } from "@/Azure/Token";
import type { Input } from "@/Input";
import * as Test from "@/Test/Alchemy";
import * as aro from "@distilled.cloud/azure/redhatopenshift";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runExpensive, runPaidOnly, withVcpus } from "../gates.ts";
import { ensureQuota } from "../quota.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:redhatopenshift", "live"];

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Region of the cores-quota probe: its regional vCPU limit stays at the
 * pay-as-you-go default of 10, below the 44 an ARO cluster needs.
 */
const probeLocation = "westus3";

/**
 * Region of the full lifecycle; the test raises its regional and DSv5
 * family vCPU quotas itself, away from the eastus quota other suites share.
 */
const clusterLocation = "eastus2";

/** First-party "Azure Red Hat OpenShift RP" application. */
const ARO_RP_APP_ID = "f1dd0a37-89c6-4e07-bcd1-ffd3d43d8875";

/** Network Contributor. */
const NETWORK_CONTRIBUTOR = "4d97b98b-1d4f-4787-a291-c67834d212e7";

const getCluster = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* aro.GetOpenShiftCluster({
      subscriptionId,
      resourceGroupName,
      resourceName,
    });
  });

const clusterGone = (resourceGroupName: string, resourceName: string) =>
  getCluster(resourceGroupName, resourceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

/** Object ID of the service principal of `appId` in this tenant. */
const servicePrincipalObjectId = (appId: string) =>
  Effect.gen(function* () {
    const creds = yield* yield* resolveAzureCredentials;
    const token = yield* mintAccessToken(
      creds,
      "https://graph.microsoft.com/.default",
    );
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(
      HttpClientRequest.get(
        `https://graph.microsoft.com/v1.0/servicePrincipals(appId='${appId}')?$select=id`,
      ).pipe(HttpClientRequest.bearerToken(Redacted.value(token.accessToken))),
    );
    const body = (yield* response.json) as { id?: string };
    expect(body.id).toBeDefined();
    return body.id!;
  });

const network = (location: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location,
      addressPrefixes: ["10.0.0.0/22"],
    });
    const master = yield* Azure.Network.Subnet("Master", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.0.0/23",
    });
    const worker = yield* Azure.Network.Subnet("Worker", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.2.0/23",
    });
    return { group, vnet, master, worker };
  });

const program = (props: {
  location: string;
  clientId: string;
  clientSecret: Redacted.Redacted<string>;
  pullSecret?: Redacted.Redacted<string>;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, vnet, master, worker } = yield* network(props.location);
    const cluster = yield* Azure.RedHatOpenShift.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      servicePrincipal: {
        clientId: props.clientId,
        clientSecret: props.clientSecret,
      },
      pullSecret: props.pullSecret,
      master: { subnetId: master.subnetId },
      worker: { subnetId: worker.subnetId },
      tags: props.tags,
    });
    return { group, vnet, cluster };
  });

/**
 * Role assignments ARO needs on the virtual network: the cluster's service
 * principal and the tenant's Azure Red Hat OpenShift RP service principal
 * both need Network Contributor.
 */
const vnetRoles = (
  vnetId: Input<string>,
  clusterPrincipalId: string,
  rpPrincipalId: string,
) =>
  Effect.gen(function* () {
    yield* Azure.Authorization.RoleAssignment("ClusterSpNetwork", {
      scope: vnetId,
      roleDefinitionId: NETWORK_CONTRIBUTOR,
      principalId: clusterPrincipalId,
      principalType: "ServicePrincipal",
    });
    yield* Azure.Authorization.RoleAssignment("RpSpNetwork", {
      scope: vnetId,
      roleDefinitionId: NETWORK_CONTRIBUTOR,
      principalId: rpPrincipalId,
      principalType: "ServicePrincipal",
    });
  });

// The smallest cluster is 3 × Standard_D8s_v5 control plane + 3 ×
// Standard_D4s_v5 workers = 36 vCPUs (44 with the bootstrap node, all in
// the DSv5 family), ~$3/hour including the ARO worker fee, 35-45 minutes to
// create and 20-30 to delete: ~$6 and ~1.5 hours per run. The test raises
// the eastus2 regional and DSv5 quotas itself (the DSv5 family raise from
// its default of 0 needs a one-time support request: Microsoft.Quota
// answers ContactSupport, and the RP reports the SKU as restricted), uses the test's own service
// principal as the cluster service principal, and resolves the ARO RP
// service principal through Microsoft Graph. Set ARO_PULL_SECRET to install
// with a Red Hat pull secret.
test.provider.skipIf(!runPaidOnly || !runExpensive)(
  "create, update tags, and delete an OpenShift cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      for (const resourceName of ["cores", "standardDSv5Family"]) {
        yield* ensureQuota({
          provider: "Microsoft.Compute",
          resourceName,
          minimum: 48,
          location: clusterLocation,
        });
      }

      const creds = yield* yield* resolveAzureCredentials;
      const clusterPrincipalId = yield* servicePrincipalObjectId(
        creds.clientId,
      );
      const rpPrincipalId = yield* servicePrincipalObjectId(ARO_RP_APP_ID);
      const pullSecret = process.env.ARO_PULL_SECRET
        ? Redacted.make(process.env.ARO_PULL_SECRET)
        : undefined;

      // The roles must exist before the cluster PUT validates them, and a
      // role assignment is not an input of the cluster, so they deploy first.
      const base = Effect.gen(function* () {
        const out = yield* network(clusterLocation);
        yield* vnetRoles(
          out.vnet.virtualNetworkId,
          clusterPrincipalId,
          rpPrincipalId,
        );
        return out;
      });
      const withCluster = (clusterTags: Record<string, string>) =>
        Effect.gen(function* () {
          yield* base;
          return yield* program({
            location: clusterLocation,
            clientId: creds.clientId,
            clientSecret: creds.clientSecret,
            pullSecret,
            tags: clusterTags,
          });
        });

      yield* stack.deploy(base);
      const { group, cluster } = yield* stack.deploy(
        withCluster({ env: "test" }),
      );
      expect(cluster.provisioningState).toEqual("Succeeded");
      expect(cluster.consoleUrl).toContain("console-openshift-console");
      expect(cluster.apiServerUrl).toContain(":6443");
      expect(cluster.kubeadminUsername).toEqual("kubeadmin");
      expect(cluster.kubeadminPassword).toBeDefined();
      expect(cluster.kubeconfig).toBeDefined();
      const observed = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.properties?.workerProfiles?.[0]?.count).toEqual(3);

      // In place: tags.
      const updated = yield* stack.deploy(withCluster({ env: "prod" }));
      expect(updated.cluster.clusterId).toEqual(cluster.clusterId);
      const reobserved = yield* getCluster(
        group.resourceGroupName,
        cluster.clusterName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.provisioningState).toEqual("Succeeded");

      yield* stack.destroy();
      expect(
        yield* clusterGone(group.resourceGroupName, cluster.clusterName),
      ).toEqual("gone");
    }).pipe(withVcpus(44), logLevel),
  { tags, timeout: 10_800_000 },
);

// Ungated probe (resource group + VNet + 2 subnets, free, ~2 minutes): the
// ARO RP validates the cluster's 44 vCPUs (3 × D8s_v5 control plane, 3 ×
// D4s_v5 workers, bootstrap) against the regional cores quota synchronously
// on PUT, before the service principal. westus3 keeps the subscription's
// default regional quota of 10 vCPUs, so the cluster is rejected with a
// typed error and nothing is provisioned.
test.provider(
  "cluster creation is rejected with a typed regional cores quota error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(network(probeLocation));
      const error = yield* stack
        .deploy(
          program({
            location: probeLocation,
            clientId: "00000000-0000-0000-0000-000000000001",
            clientSecret: Redacted.make("not-a-real-secret"),
            tags: {},
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(error)).toContain(
        '"_tag":"RedHatOpenShiftCoresQuotaExceeded"',
      );

      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const listed = yield* aro.ListOpenShiftClusterByResourceGroup({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
      });
      expect(listed.value ?? []).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
