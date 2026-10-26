import { expect } from "bun:test";
import * as Azure from "@alchemy.run/azure";
import * as Kubernetes from "@alchemy.run/kubernetes";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import * as cs from "@distilled.cloud/azure/containerservice";
import * as msi from "@distilled.cloud/azure/msi";
import * as Alchemy from "alchemy";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Bun";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Azure.providers(), Kubernetes.providers()),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

/** The deployer's credentials, for out-of-band ARM reads. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

const ACR_PULL = "7f951dda-4ed3-4680-a7ca-43fe172d538d";

// One Standard_D2s_v7 node (~$0.10/h) on the Free tier, a Basic registry,
// a Standard load balancer with one public IP, and a Standard LRS storage
// account: well under $1 per run. The cluster takes ~6 minutes to create and
// ~5 minutes to delete.
const stack = beforeAll(deploy(Stack), { timeout: 1_800_000 });

class NotOk extends Data.TaggedError("NotOk")<{ readonly status: number; readonly body: string }> {}

/** Call the API; retry until it answers `expected`. */
const call = (method: "GET" | "PUT", path: string, expected: number, body?: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const target = `${String(url).replace(/\/+$/, "")}${path}`;
    // A fresh connection per attempt: the Azure load balancer silently drops
    // idle pooled connections after 4 minutes.
    const request = (
      method === "PUT"
        ? HttpClientRequest.put(target).pipe(HttpClientRequest.bodyText(body ?? ""))
        : HttpClientRequest.get(target)
    ).pipe(HttpClientRequest.setHeader("connection", "close"));
    const { status, text } = yield* client.execute(request).pipe(
      Effect.flatMap((res) => Effect.map(res.text, (text) => ({ status: res.status, text }))),
      Effect.timeout("15 seconds"),
      Effect.mapError((error) => new NotOk({ status: 0, body: String(error) })),
    );
    if (status !== expected) return yield* new NotOk({ status, body: text });
    return text;
  }).pipe(
    // The first image pull (AcrPull propagating to the kubelet), the load
    // balancer's first health probes, and the federated credential and the
    // blob role propagating after the first deploy take a few minutes.
    // At most ~16 minutes.
    Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 40 }),
  );

/** Where the example's resources are, from the stack outputs. */
const where = Effect.gen(function* () {
  const outputs = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
  const identity = outputs.identity;
  const registry = outputs.registry;
  if (identity?.kind !== "azure-workload-identity") {
    return yield* Effect.die(new Error(`the Api has no workload identity: ${String(identity)}`));
  }
  if (registry?.kind !== "azure-container-registry") {
    return yield* Effect.die(new Error(`the Api has no registry: ${String(registry)}`));
  }
  return { subscriptionId, ...outputs, identity, registry };
});

type Where = Effect.Success<typeof where>;

const gone = () => Effect.succeed("gone" as const);
const notFound = ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"] as const;

const clusterStatus = (ids: Where) =>
  cs
    .GetManagedCluster({
      subscriptionId: ids.subscriptionId,
      resourceGroupName: ids.resourceGroup,
      resourceName: ids.clusterName,
    })
    .pipe(Effect.as("found" as const), Effect.catchTag(notFound, gone), Effect.provide(azure));

const identityStatus = (ids: Where) =>
  msi
    .GetUserAssignedIdentity({
      subscriptionId: ids.identity.subscriptionId,
      resourceGroupName: ids.identity.resourceGroup,
      resourceName: ids.identity.identityName,
    })
    .pipe(Effect.as("found" as const), Effect.catchTag(notFound, gone), Effect.provide(azure));

const registryStatus = (ids: Where) =>
  containerregistry
    .GetRegistry({
      subscriptionId: ids.registry.subscriptionId,
      resourceGroupName: ids.registry.resourceGroup,
      registryName: ids.registry.registryName,
    })
    .pipe(Effect.as("found" as const), Effect.catchTag(notFound, gone), Effect.provide(azure));

/** `<scope>|<role GUID>` of every role assignment `principalId` holds. */
const grantsOf = (subscriptionId: string, principalId: string) =>
  authorization
    .ListRoleAssignmentForSubscription({
      subscriptionId,
      _filter: `principalId eq '${principalId}'`,
    })
    .pipe(
      Effect.map((page) =>
        page.value
          .map(
            (a) =>
              `${a.properties?.scope?.toLowerCase()}|${a.properties?.roleDefinitionId?.split("/").pop()}`,
          )
          .sort(),
      ),
      Effect.provide(azure),
    );

/**
 * The grants, polled until `ready` accepts them: role-assignment lists
 * trail writes and deletes by up to a minute.
 */
const settledGrants = (
  subscriptionId: string,
  principalId: string,
  ready: (grants: string[]) => boolean,
) =>
  grantsOf(subscriptionId, principalId).pipe(
    Effect.repeat({ schedule: Schedule.spaced("5 seconds"), until: ready, times: 18 }),
  );

/** Poll until a deleted resource reads as gone. */
const untilGone = <E, R>(current: Effect.Effect<"found" | "gone", E, R>) =>
  current.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (s) => s === "gone",
      times: 30,
    }),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const ids = yield* where;
    yield* destroy(Stack);
    expect(yield* untilGone(identityStatus(ids))).toBe("gone");
    expect(yield* untilGone(registryStatus(ids))).toBe("gone");
    expect(yield* untilGone(clusterStatus(ids))).toBe("gone");
    // The binding's role assignment went with the identity.
    expect(
      yield* settledGrants(ids.subscriptionId, ids.identity.principalId, (g) => g.length === 0),
    ).toEqual([]);
  }),
  // Deleting the cluster and its node resource group takes ~5-10 minutes.
  { timeout: 1_800_000 },
);

test(
  "the API answers on its load balancer",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(String(url)).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:3000$/);
    expect(yield* call("GET", "/", 200)).toBe("ok");
  }),
  { timeout: 1_200_000 },
);

test(
  "a stored note reads back through the blob binding (workload identity)",
  Effect.gen(function* () {
    const key = crypto.randomUUID();
    const text = `hello from ${key}`;
    expect(yield* call("PUT", `/notes/${key}`, 201, text)).toBe("stored");
    expect(yield* call("GET", `/notes/${key}`, 200)).toBe(text);
    expect(yield* call("GET", `/notes/${crypto.randomUUID()}`, 404)).toBe("not found");
  }),
  { timeout: 1_200_000 },
);

test(
  "the ServiceAccount is federated with an identity that holds Blob Data Contributor on the container only",
  Effect.gen(function* () {
    const ids = yield* where;
    const cluster = yield* cs
      .GetManagedCluster({
        subscriptionId: ids.subscriptionId,
        resourceGroupName: ids.resourceGroup,
        resourceName: ids.clusterName,
      })
      .pipe(Effect.provide(azure));
    expect(cluster.properties?.securityProfile?.workloadIdentity?.enabled).toBe(true);

    const identity = yield* msi
      .GetUserAssignedIdentity({
        subscriptionId: ids.identity.subscriptionId,
        resourceGroupName: ids.identity.resourceGroup,
        resourceName: ids.identity.identityName,
      })
      .pipe(Effect.provide(azure));
    expect(identity.properties?.clientId).toBe(ids.identity.clientId);
    expect(identity.properties?.principalId).toBe(ids.identity.principalId);
    expect(identity.tags?.["alchemy::id"]).toBe("Api");

    const credentials = yield* msi
      .ListFederatedIdentityCredentials({
        subscriptionId: ids.identity.subscriptionId,
        resourceGroupName: ids.identity.resourceGroup,
        resourceName: ids.identity.identityName,
      })
      .pipe(Effect.provide(azure));
    expect(
      credentials.value.map((c) => ({
        issuer: c.properties?.issuer,
        subject: c.properties?.subject,
        audiences: c.properties?.audiences,
      })),
    ).toEqual([
      {
        issuer: cluster.properties?.oidcIssuerProfile?.issuerURL,
        subject: `system:serviceaccount:${ids.namespace}:${ids.serviceAccount}`,
        audiences: ["api://AzureADTokenExchange"],
      },
    ]);

    expect(
      yield* settledGrants(ids.subscriptionId, ids.identity.principalId, (g) => g.length > 0),
    ).toEqual([
      `${ids.containerId.toLowerCase()}|${Azure.Authorization.BuiltInRole.StorageBlobDataContributor}`,
    ]);
  }),
  { timeout: 120_000 },
);

test(
  "the image is pushed to the workload's registry, and the kubelet can pull it",
  Effect.gen(function* () {
    const ids = yield* where;
    const registry = yield* containerregistry
      .GetRegistry({
        subscriptionId: ids.registry.subscriptionId,
        resourceGroupName: ids.registry.resourceGroup,
        registryName: ids.registry.registryName,
      })
      .pipe(Effect.provide(azure));
    expect(registry.properties?.provisioningState).toBe("Succeeded");
    expect(registry.properties?.adminUserEnabled).toBe(false);

    // The kubelet holds exactly AcrPull on the workload's registry.
    const registryScope = ids.registry.registryId.toLowerCase();
    const onRegistry = (grants: string[]) =>
      grants.filter((grant) => grant.startsWith(`${registryScope}|`));
    const kubeletGrants = yield* settledGrants(
      ids.subscriptionId,
      String(ids.kubeletObjectId),
      (grants) => onRegistry(grants).length > 0,
    );
    expect(onRegistry(kubeletGrants)).toEqual([`${registryScope}|${ACR_PULL}`]);
  }),
  { timeout: 120_000 },
);
