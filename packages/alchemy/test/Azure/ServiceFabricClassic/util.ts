import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = [
  "provider:azure",
  "provider:azure:servicefabricclassic",
  "live",
];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/**
 * Classic clusters must be secured, but the cluster resource only records
 * the thumbprint; the certificate itself is installed on the node scale
 * sets, which these tests never deploy.
 */
export const testCertificate = {
  thumbprint: "1A2B3C4D5E6F708192A3B4C5D6E7F8091A2B3C4D",
  x509StoreName: "My",
};

/** A single-node test node type (no VMs are deployed). */
export const testNodeTypes = (vmInstanceCount = 1) => [
  {
    name: "nt1",
    isPrimary: true,
    vmInstanceCount,
    clientConnectionEndpointPort: 19000,
    httpGatewayEndpointPort: 19080,
    applicationPorts: { startPort: 20000, endPort: 30000 },
    ephemeralPorts: { startPort: 49152, endPort: 65534 },
    durabilityLevel: "Bronze",
  },
];

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 36,
    }),
  );

/**
 * Application type versions, applications, and services need a `Ready`
 * classic cluster (node scale sets with the `ServiceFabricNode` extension,
 * a Key Vault cluster certificate) and an `.sfpkg` package reachable from
 * it. Building one takes 20-30 minutes, so these lifecycles run only with
 * `AZURE_TEST_EXPENSIVE=1` against a cluster described by:
 *
 * - `AZURE_TEST_SF_RESOURCE_GROUP` / `AZURE_TEST_SF_CLUSTER` — the cluster
 * - `AZURE_TEST_SF_PACKAGE_URL` — SAS URL of an `.sfpkg` whose manifest
 *   declares `AZURE_TEST_SF_TYPE_NAME` version `AZURE_TEST_SF_TYPE_VERSION`
 *   with a stateless service type `AZURE_TEST_SF_SERVICE_TYPE`
 */
export const readyCluster = (() => {
  const env = process.env;
  const resourceGroup = env.AZURE_TEST_SF_RESOURCE_GROUP;
  const cluster = env.AZURE_TEST_SF_CLUSTER;
  const packageUrl = env.AZURE_TEST_SF_PACKAGE_URL;
  const typeName = env.AZURE_TEST_SF_TYPE_NAME;
  const typeVersion = env.AZURE_TEST_SF_TYPE_VERSION;
  const serviceTypeName = env.AZURE_TEST_SF_SERVICE_TYPE;
  return resourceGroup &&
    cluster &&
    packageUrl &&
    typeName &&
    typeVersion &&
    serviceTypeName
    ? {
        resourceGroup,
        cluster,
        packageUrl,
        typeName,
        typeVersion,
        serviceTypeName,
      }
    : undefined;
})();
