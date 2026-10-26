import {
  ClusterAdapter,
  ClusterNotFoundError,
  type AdapterLifecycleServices,
  type ClusterAdapterService,
  type ClusterTransport,
  type ImageRegistryDeleteOptions,
  type ImageRegistryHashOptions,
  type ImageRegistryResolveOptions,
  type ImageRegistryResult,
  type WorkloadBindingContract,
  type WorkloadIdentityDeleteOptions,
  type WorkloadIdentityReconcileOptions,
  type WorkloadIdentityResult,
} from "@alchemy.run/kubernetes/ClusterAdapter";
import type { Connection } from "@alchemy.run/kubernetes/Connection";
/**
 * The `azure-aks` {@link ClusterAdapter}: everything platform-specific about
 * running `Kubernetes.*` workloads on Azure Kubernetes Service.
 *
 * - **connect** — reads the cluster through ARM and takes the API server
 *   endpoint, certificate authority, and admin client certificate from its
 *   admin kubeconfig. A cluster with local accounts disabled is reached
 *   with a Microsoft Entra token of the deployer instead (the deployer then
 *   needs a Kubernetes RBAC role on the cluster, e.g. Azure Kubernetes
 *   Service RBAC Cluster Admin).
 * - **identity** — Microsoft Entra Workload ID. A workload whose bindings
 *   ask for roles gets a user-assigned managed identity in the cluster's
 *   resource group, federated with its Kubernetes ServiceAccount
 *   (`system:serviceaccount:<namespace>:<name>`) through the cluster's OIDC
 *   issuer; the roles are assigned to that identity. The ServiceAccount is
 *   annotated with the identity's client ID and the pods are labelled
 *   `azure.workload.identity/use: "true"`, so the AKS webhook projects a
 *   token the pod exchanges for Entra tokens. Needs a cluster with
 *   `oidcIssuerEnabled` and `workloadIdentityEnabled`.
 * - **registry** — a per-workload Azure Container Registry (Basic). `main`
 *   programs are bundled and pushed as one layer on a public Node.js base
 *   image without Docker; the cluster's kubelet identity gets `AcrPull` on
 *   the registry. `image` references run as they are. Dockerfile builds
 *   (`context`) are not supported.
 * - **bootstrap** — generated entries that run the program on Node.js with
 *   the pod's workload identity credentials.
 *
 * Registered by `Azure.providers()`; resolved dynamically by the
 * `Kubernetes.*` providers through the connection's `auth.kind`.
 */
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import * as cs from "@distilled.cloud/azure/containerservice";
import * as msi from "@distilled.cloud/azure/msi";
import * as Bundle from "alchemy/Bundle/Bundle";
import { findCwdForBundle, resolveMainPath } from "alchemy/Bundle/TempRoot";
import { createPhysicalName } from "alchemy/PhysicalName";
import type { ResourceBinding } from "alchemy/Resource";
import { sha256Object } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as YAML from "yaml";
import {
  collectAll,
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  tagsDiffer,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import {
  deterministicGuid,
  descriptionWithMarker,
  ownershipMarker,
} from "../Authorization/Ownership.ts";
import { roleDefinitionIdOf } from "../Authorization/RoleAssignment.ts";
import { managedIdentityHostBundle, type HostRoleAssignment } from "../AzureBindings.ts";
import { syncBindingAssignments } from "../ContainerApps/ContainerApp.ts";
import { DEFAULT_BASE_IMAGE, pushProgramImage } from "../ContainerApps/internal/image.ts";
import { createRegistryName, getRegistry } from "../ContainerRegistry/Common.ts";
import { AzureEnvironment } from "../Environment.ts";
import { getCluster } from "./Common.ts";
import "./KubernetesConnection.ts";

declare module "@alchemy.run/kubernetes/ClusterAdapter" {
  interface IdentityStateRegistry {
    /**
     * Microsoft Entra Workload ID: a user-assigned managed identity
     * federated with the workload's Kubernetes ServiceAccount.
     */
    "azure-workload-identity": {
      subscriptionId: string;
      resourceGroup: string;
      /** Name of the user-assigned managed identity. */
      identityName: string;
      /** ARM resource ID of the identity. */
      identityId: string;
      /** Client ID the ServiceAccount is annotated with. */
      clientId: string;
      /** Principal ID the binding roles are assigned to. */
      principalId: string;
      /** Name of the federated identity credential on the identity. */
      federatedCredentialName: string;
    };
  }
  interface RegistryStateRegistry {
    /** The per-workload Azure Container Registry holding the image. */
    "azure-container-registry": {
      subscriptionId: string;
      resourceGroup: string;
      registryName: string;
      /** `<name>.azurecr.io`. */
      loginServer: string;
      /** ARM resource ID of the registry. */
      registryId: string;
      /** Name of the kubelet's `AcrPull` role assignment on the registry. */
      pullAssignmentName: string;
    };
  }
  interface WorkloadBindingContract {
    /**
     * Azure RBAC roles assigned to the workload's Entra Workload ID (AKS
     * only) — the same host-binding channel as Azure Container Apps and
     * Functions.
     */
    roleAssignments?: HostRoleAssignment[];
  }
  interface WorkloadServicesRegistry {
    /** Azure credentials ambient inside AKS workload pods (workload identity). */
    azure: Credentials;
  }
}

/** Services the adapter's methods close over at layer build. */
type AksAdapterDeps =
  | Credentials
  | AzureEnvironment
  | HttpClient
  | FileSystem.FileSystem
  | Path.Path;

/** Binding channels an AKS workload can materialize. */
const AKS_BINDING_KEYS = new Set(["env", "roleAssignments"]);

/** Entra application ID of the AKS AAD server (the Kubernetes API audience). */
const AKS_AAD_SERVER_SCOPE = "6dae42f8-4368-4678-94ff-3960e28e3630/.default";

/** Built-in `AcrPull` role. */
const ACR_PULL_ROLE = "7f951dda-4ed3-4680-a7ca-43fe172d538d";

/** Audience of the tokens AKS projects for workload identity. */
const WORKLOAD_IDENTITY_AUDIENCE = "api://AzureADTokenExchange";

/** Repository of the program image in the workload's registry. */
const IMAGE_REPOSITORY = "app";

const PACKAGE_JSON = new TextEncoder().encode(
  `${JSON.stringify({ type: "module", main: "index.mjs" }, null, 2)}\n`,
);

/** The cluster's kubeconfig had no usable cluster or credentials. */
export class AksKubeconfigInvalid extends Data.TaggedError(
  "Azure.ContainerService.AksKubeconfigInvalid",
)<{
  message: string;
}> {}

/** Bindings ask for roles, but the cluster has no workload identity. */
export class AksWorkloadIdentityDisabled extends Data.TaggedError(
  "Azure.ContainerService.AksWorkloadIdentityDisabled",
)<{ message: string }> {}

/** The cluster is not ready for a workload (no identity IDs, no kubelet identity yet). */
export class AksClusterNotReady extends Data.TaggedError(
  "Azure.ContainerService.AksClusterNotReady",
)<{
  message: string;
}> {}

/** The workload's image source cannot be built for AKS. */
export class AksImageSourceUnsupported extends Data.TaggedError(
  "Azure.ContainerService.AksImageSourceUnsupported",
)<{ message: string }> {}

type AksAuth = Extract<Connection["auth"], { kind: "azure-aks" }>;

const narrowAksAuth = (connection: Connection) =>
  connection.auth.kind === "azure-aks"
    ? Effect.succeed(connection.auth as AksAuth)
    : Effect.die(new Error(`azure-aks adapter received auth kind '${connection.auth.kind}'`));

interface KubeconfigFile {
  clusters?: { cluster?: { server?: string; "certificate-authority-data"?: string } }[];
  users?: {
    user?: { "client-certificate-data"?: string; "client-key-data"?: string; token?: string };
  }[];
}

const fromBase64 = (value: string) =>
  Effect.sync(() => Buffer.from(value, "base64").toString("utf8"));

/** Parse the first (and only) cluster and user of a kubeconfig ARM returned base64-encoded. */
const parseKubeconfig = (encoded: string | undefined, clusterName: string) =>
  Effect.gen(function* () {
    if (encoded === undefined) {
      return yield* new AksKubeconfigInvalid({
        message: `AKS cluster '${clusterName}' returned no kubeconfig`,
      });
    }
    const text = yield* fromBase64(encoded);
    const parsed = yield* Effect.try({
      try: () => YAML.parse(text) as KubeconfigFile,
      catch: () =>
        new AksKubeconfigInvalid({
          message: `AKS cluster '${clusterName}' returned a kubeconfig that is not YAML`,
        }),
    });
    const cluster = parsed.clusters?.[0]?.cluster;
    const endpoint = cluster?.server;
    const certificateAuthorityData = cluster?.["certificate-authority-data"];
    if (endpoint === undefined || certificateAuthorityData === undefined) {
      return yield* new AksKubeconfigInvalid({
        message: `AKS cluster '${clusterName}' kubeconfig has no server or certificate authority`,
      });
    }
    return { endpoint, certificateAuthorityData, user: parsed.users?.[0]?.user };
  });

/** A valid Kubernetes object-name fragment for an ARM child name. */
const armNameFragment = (value: string) => value.replace(/[^A-Za-z0-9-_]+/g, "-");

const federatedCredentialNameOf = (namespace: string, serviceAccount: string) =>
  `kubernetes-${armNameFragment(namespace)}-${armNameFragment(serviceAccount)}`.slice(0, 120);

const createIdentityName = (id: string) =>
  createPhysicalName({ id: `${id}-identity`, maxLength: 128 });

/** Narrow persisted identity state. */
const identityStateOf = (state: Record<string, unknown> | undefined) => {
  const str = (key: string) =>
    typeof state?.[key] === "string" ? (state[key] as string) : undefined;
  return {
    subscriptionId: str("subscriptionId"),
    resourceGroup: str("resourceGroup"),
    identityName: str("identityName"),
    principalId: str("principalId"),
    federatedCredentialName: str("federatedCredentialName"),
  };
};

/** Narrow persisted registry state. */
const registryStateOf = (state: Record<string, unknown> | undefined) => {
  const str = (key: string) =>
    typeof state?.[key] === "string" ? (state[key] as string) : undefined;
  return {
    subscriptionId: str("subscriptionId"),
    resourceGroup: str("resourceGroup"),
    registryName: str("registryName"),
    registryId: str("registryId"),
    pullAssignmentName: str("pullAssignmentName"),
  };
};

/** Role grants of the bindings a deploy keeps, de-duplicated. */
const collectGrants = (id: string, bindings: ResourceBinding<WorkloadBindingContract>[]) =>
  Effect.gen(function* () {
    const active = bindings.filter(
      (binding: ResourceBinding<WorkloadBindingContract> & { action?: string }) =>
        binding.action !== "delete",
    );
    const unsupported = [
      ...new Set(
        active.flatMap((binding) =>
          Object.entries(binding.data ?? {})
            .filter(([key, value]) => value !== undefined && !AKS_BINDING_KEYS.has(key))
            .map(([key]) => key),
        ),
      ),
    ];
    if (unsupported.length > 0) {
      return yield* Effect.die(
        new Error(
          `'${id}': bindings carry ${unsupported.join(", ")}, which AKS workloads cannot ` +
            "materialize (only env and Azure `roleAssignments`).",
        ),
      );
    }
    const grants = new Map<string, HostRoleAssignment>();
    for (const binding of active) {
      for (const grant of binding.data?.roleAssignments ?? []) {
        grants.set(`${grant.scope.toLowerCase()}|${grant.roleDefinitionId.toLowerCase()}`, grant);
      }
    }
    return [...grants.values()];
  });

/** Every role assignment held by `principalId` in the subscription. */
const assignmentsOf = (subscriptionId: string, principalId: string) =>
  collectAll(authorization.ListRoleAssignmentForSubscription, {
    subscriptionId,
    _filter: `principalId eq '${principalId}'`,
  });

/** Remove a workload identity: its role assignments, then the identity (and its federated credential). */
const deleteIdentity = Effect.fn(function* (state: ReturnType<typeof identityStateOf>) {
  const { subscriptionId, resourceGroup, identityName, principalId } = state;
  if (subscriptionId === undefined || resourceGroup === undefined || identityName === undefined) {
    return;
  }
  // The identity is this workload's own, so every assignment it holds came
  // from this workload's bindings.
  if (principalId !== undefined) {
    const page = yield* assignmentsOf(subscriptionId, principalId);
    for (const assignment of page.value) {
      const scope = assignment.properties?.scope;
      if (scope === undefined || assignment.name === undefined) continue;
      yield* ignoreNotFound(
        authorization.DeleteRoleAssignment({ scope, roleAssignmentName: assignment.name }),
      );
    }
  }
  yield* ignoreNotFound(
    msi.DeleteUserAssignedIdentity({
      subscriptionId,
      resourceGroupName: resourceGroup,
      resourceName: identityName,
    }),
  );
});

/** Remove a workload's registry: the kubelet's pull grant, then the registry. */
const deleteRegistry = Effect.fn(function* (state: ReturnType<typeof registryStateOf>) {
  const { subscriptionId, resourceGroup, registryName, registryId, pullAssignmentName } = state;
  if (subscriptionId === undefined || resourceGroup === undefined || registryName === undefined) {
    return;
  }
  if (registryId !== undefined && pullAssignmentName !== undefined) {
    yield* ignoreNotFound(
      authorization.DeleteRoleAssignment({
        scope: registryId,
        roleAssignmentName: pullAssignmentName,
      }),
    );
  }
  yield* ignoreNotFound(
    containerregistry.DeleteRegistry({
      subscriptionId,
      resourceGroupName: resourceGroup,
      registryName,
    }),
  );
  yield* waitUntilGone(
    `container registry ${registryName}`,
    getRegistry(subscriptionId, resourceGroup, registryName),
    { interval: "5 seconds", times: 60 },
  );
});

/** Generated entry of an Effect-native server: raise the runtime flag, run the program. */
export const makeAksServerBootstrap = (handler: string) => (importPath: string) =>
  `
import { bootstrap } from "@alchemy.run/azure/Bootstrap/KubernetesDeployment";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`;

/** Generated entry of an Effect-native one-shot Job. */
export const makeAksJobBootstrap = (handler: string) => (importPath: string) =>
  `
import { bootstrap } from "@alchemy.run/azure/Bootstrap/KubernetesJob";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

await bootstrap(entrypoint);
`;

/**
 * The `azure-aks` cluster adapter layer. Provided (merged) by
 * `Azure.providers()` so the `Kubernetes.*` workload providers can resolve
 * it from the stack context.
 */
export const AksKubernetesAdapter = () =>
  Layer.effect(
    ClusterAdapter("azure-aks"),
    Effect.gen(function* () {
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      const context = yield* Effect.context<AksAdapterDeps>();

      const withAzure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
        Effect.provideContext(self, context);

      const subscriptionOf = (auth: AksAuth) =>
        AzureEnvironment.current.pipe(
          Effect.map((env) => auth.subscriptionId ?? env.subscriptionId),
        );

      /** The live cluster, or {@link ClusterNotFoundError} once it is gone or going. */
      const getLiveCluster = Effect.fn(function* (auth: AksAuth) {
        const subscriptionId = yield* subscriptionOf(auth);
        const cluster = yield* getCluster(subscriptionId, auth.resourceGroup, auth.clusterName);
        if (cluster === undefined || cluster.properties?.provisioningState === "Deleting") {
          return yield* new ClusterNotFoundError({
            message: `AKS cluster '${auth.clusterName}' no longer exists`,
          });
        }
        return { subscriptionId, cluster };
      });

      const connect: ClusterAdapterService["connect"] = (connection) =>
        Effect.gen(function* () {
          const auth = yield* narrowAksAuth(connection);
          // Always read the cluster: a persisted endpoint does not prove it
          // still exists, and delete relies on ClusterNotFoundError.
          const { subscriptionId, cluster } = yield* getLiveCluster(auth);
          const where = {
            subscriptionId,
            resourceGroupName: auth.resourceGroup,
            resourceName: auth.clusterName,
          };
          if (cluster.properties?.disableLocalAccounts === true) {
            // Entra-only cluster: the user kubeconfig carries the endpoint
            // and CA; requests carry the deployer's Entra token.
            const user = yield* cs.ListManagedClusterClusterUserCredentials({
              ...where,
              format: "exec",
            });
            const parsed = yield* parseKubeconfig(user.kubeconfigs?.[0]?.value, auth.clusterName);
            const credentialsContext = yield* Effect.context<Credentials>();
            return {
              endpoint: parsed.endpoint,
              certificateAuthorityData: parsed.certificateAuthorityData,
              headers: Effect.gen(function* () {
                const resolve = yield* Credentials;
                const config = yield* resolve;
                if (config.tokenFor === undefined) {
                  return yield* Effect.fail(
                    new Error("the deployer's Azure credentials cannot mint an AKS token"),
                  );
                }
                const token = yield* config.tokenFor(AKS_AAD_SERVER_SCOPE);
                return { Authorization: `Bearer ${Redacted.value(token)}` };
              }).pipe(
                Effect.provideContext(credentialsContext),
                Effect.mapError((error) =>
                  error instanceof Error ? error : new Error(String(error)),
                ),
              ),
            } satisfies ClusterTransport;
          }
          const admin = yield* cs.ListManagedClusterClusterAdminCredentials(where);
          const parsed = yield* parseKubeconfig(admin.kubeconfigs?.[0]?.value, auth.clusterName);
          const certificate = parsed.user?.["client-certificate-data"];
          const key = parsed.user?.["client-key-data"];
          const token = parsed.user?.token;
          if ((certificate === undefined || key === undefined) && token === undefined) {
            return yield* new AksKubeconfigInvalid({
              message: `AKS cluster '${auth.clusterName}' admin kubeconfig has no credentials`,
            });
          }
          const clientCert =
            certificate !== undefined && key !== undefined
              ? { certificate: yield* fromBase64(certificate), key: yield* fromBase64(key) }
              : undefined;
          return {
            endpoint: parsed.endpoint,
            certificateAuthorityData: parsed.certificateAuthorityData,
            ...(clientCert !== undefined ? { clientCert } : {}),
            headers: Effect.succeed<Record<string, string>>(
              clientCert === undefined && token !== undefined
                ? { Authorization: `Bearer ${token}` }
                : {},
            ),
          } satisfies ClusterTransport;
        }).pipe(
          withAzure,
          Effect.mapError((error): ClusterNotFoundError | Error =>
            error instanceof ClusterNotFoundError || error instanceof Error
              ? error
              : new Error(
                  `connecting to the AKS cluster failed: ${
                    (error as { message?: string }).message ?? String(error)
                  }`,
                ),
          ),
        );

      const identityReconcile = (
        options: WorkloadIdentityReconcileOptions,
      ): Effect.Effect<WorkloadIdentityResult, any, AdapterLifecycleServices> =>
        Effect.gen(function* () {
          const auth = yield* narrowAksAuth(options.connection);
          const grants = yield* collectGrants(options.id, options.bindings);
          const previous = identityStateOf(options.state);

          // No roles to hold: no identity (and none left from earlier deploys).
          if (grants.length === 0) {
            yield* deleteIdentity(previous);
            return { env: {}, state: undefined };
          }

          const { subscriptionId, cluster } = yield* getLiveCluster(auth);
          const issuer = cluster.properties?.oidcIssuerProfile?.issuerURL;
          if (
            cluster.properties?.securityProfile?.workloadIdentity?.enabled !== true ||
            issuer === undefined
          ) {
            return yield* new AksWorkloadIdentityDisabled({
              message:
                `'${options.id}': its bindings assign Azure roles, so AKS cluster ` +
                `'${auth.clusterName}' needs oidcIssuerEnabled and workloadIdentityEnabled.`,
            });
          }
          yield* ensureRegistered(subscriptionId, "Microsoft.ManagedIdentity");

          const resourceGroup =
            previous.subscriptionId === subscriptionId && previous.resourceGroup !== undefined
              ? previous.resourceGroup
              : auth.resourceGroup;
          const identityName = previous.identityName ?? (yield* createIdentityName(options.id));
          const where = {
            subscriptionId,
            resourceGroupName: resourceGroup,
            resourceName: identityName,
          };

          // Observe → ensure the identity (tags synced against the cloud).
          let identity = yield* orUndefinedIfNotFound(msi.GetUserAssignedIdentity(where));
          if (identity === undefined || tagsDiffer(identity.tags, options.tags)) {
            identity = yield* msi.UserAssignedIdentitiesCreateOrUpdate({
              ...where,
              location: identity?.location ?? cluster.location,
              tags: options.tags,
            });
          }
          const identityId = identity.id ?? "";
          const clientId = identity.properties?.clientId;
          const principalId = identity.properties?.principalId;
          const tenantId = identity.properties?.tenantId;
          if (clientId === undefined || principalId === undefined) {
            return yield* new AksClusterNotReady({
              message: `managed identity ${identityName} has no client or principal ID`,
            });
          }

          // Federate the ServiceAccount with the identity.
          const federatedCredentialName = federatedCredentialNameOf(
            options.namespace,
            options.serviceAccount,
          );
          const desired = {
            issuer,
            subject: `system:serviceaccount:${options.namespace}:${options.serviceAccount}`,
            audiences: [WORKLOAD_IDENTITY_AUDIENCE],
          };
          const ficWhere = {
            ...where,
            federatedIdentityCredentialResourceName: federatedCredentialName,
          };
          const observedFic = yield* orUndefinedIfNotFound(
            msi.GetFederatedIdentityCredentials(ficWhere),
          );
          const ficProps = observedFic?.properties;
          if (
            ficProps === undefined ||
            ficProps.issuer !== desired.issuer ||
            ficProps.subject !== desired.subject ||
            ficProps.audiences.join(",") !== desired.audiences.join(",")
          ) {
            yield* msi
              .FederatedIdentityCredentialsCreateOrUpdate({ ...ficWhere, properties: desired })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "FederatedIdentityCredentialWriteConflict",
                  schedule: Schedule.spaced("3 seconds"),
                  times: 10,
                }),
              );
          }
          if (
            previous.federatedCredentialName !== undefined &&
            previous.federatedCredentialName !== federatedCredentialName &&
            previous.identityName === identityName
          ) {
            yield* ignoreNotFound(
              msi.DeleteFederatedIdentityCredentials({
                ...where,
                federatedIdentityCredentialResourceName: previous.federatedCredentialName,
              }),
            );
          }
          // A different identity (moved resource group or subscription): drop the old one.
          if (
            previous.identityName !== undefined &&
            (previous.identityName !== identityName ||
              previous.resourceGroup !== resourceGroup ||
              previous.subscriptionId !== subscriptionId)
          ) {
            yield* deleteIdentity(previous);
          }

          // Converge the identity's role assignments to exactly the grants.
          yield* syncBindingAssignments({
            id: options.id,
            subscriptionId,
            appId: identityId,
            principalId,
            grants,
          });

          return {
            env: {},
            serviceAccountAnnotations: {
              "azure.workload.identity/client-id": clientId,
              ...(tenantId !== undefined ? { "azure.workload.identity/tenant-id": tenantId } : {}),
            },
            podLabels: { "azure.workload.identity/use": "true" },
            state: {
              kind: "azure-workload-identity" as const,
              subscriptionId,
              resourceGroup,
              identityName,
              identityId,
              clientId,
              principalId,
              federatedCredentialName,
            },
          } satisfies WorkloadIdentityResult;
        }).pipe(withAzure);

      const identityDelete = (
        options: WorkloadIdentityDeleteOptions,
      ): Effect.Effect<void, any, AdapterLifecycleServices> =>
        // The identity lives in ARM, not in the cluster, so it is removed
        // even when the cluster is gone.
        deleteIdentity(identityStateOf(options.state)).pipe(withAzure);

      /** Bundle `main` (with the generated entry unless it runs as-is) into image files. */
      const bundleProgram = Effect.fn(function* (options: {
        main: string;
        build?: ImageRegistryHashOptions["source"]["build"];
        isExternal?: boolean | undefined;
        bootstrap: (importPath: string) => string;
      }) {
        const realMain = yield* resolveMainPath(options.main);
        const cwd = yield* findCwdForBundle(realMain);
        const output = yield* Bundle.build(
          managedIdentityHostBundle({
            ...options.build?.input,
            input: realMain,
            cwd,
            platform: "node",
            resolve: {
              conditionNames: [...Bundle.NODE_CONDITION_NAMES],
              ...options.build?.input?.resolve,
            },
            plugins: [
              options.build?.input?.plugins,
              options.isExternal ? undefined : virtualEntryPlugin(options.bootstrap),
            ],
          }),
          {
            ...options.build?.output,
            format: "esm",
            sourcemap: options.build?.output?.sourcemap ?? false,
            entryFileNames: "index.mjs",
          },
          options.build,
        );
        const files = [
          ...output.files.map((file) => ({
            path: file.path,
            content:
              typeof file.content === "string"
                ? new TextEncoder().encode(file.content)
                : file.content,
          })),
          { path: "package.json", content: PACKAGE_JSON },
        ];
        const codeHash = (yield* sha256Object({
          bundle: output.hash,
          baseImage: DEFAULT_BASE_IMAGE,
        })).slice(0, 16);
        return { files, codeHash };
      });

      const staticImageHash = (image: string, platform: string) =>
        sha256Object({ image, platform }).pipe(Effect.map((hash) => hash.slice(0, 16)));

      const unsupportedSource = (id: string, source: ImageRegistryHashOptions["source"]) =>
        source.main === undefined && source.image === undefined
          ? new AksImageSourceUnsupported({
              message:
                `'${id}': AKS workloads build images without Docker, so they take a ` +
                "`main` program or a pre-built `image`, not a `context` / `dockerfile`.",
            })
          : undefined;

      const registryResolve = (
        options: ImageRegistryResolveOptions,
      ): Effect.Effect<ImageRegistryResult, any, AdapterLifecycleServices> =>
        Effect.gen(function* () {
          const source = options.source;
          const previous = registryStateOf(options.state);
          const unsupported = unsupportedSource(options.id, source);
          if (unsupported !== undefined) return yield* unsupported;

          // A pre-built image runs as it is; a registry left from an
          // earlier `main` is removed.
          if (source.main === undefined) {
            yield* deleteRegistry(previous);
            return {
              imageUri: source.image!,
              codeHash: yield* staticImageHash(source.image!, options.platform),
              state: undefined,
            } satisfies ImageRegistryResult;
          }
          if (options.platform !== "linux/amd64") {
            return yield* new AksImageSourceUnsupported({
              message: `'${options.id}': AKS program images are built for linux/amd64 only`,
            });
          }
          if (options.connection === undefined) {
            return yield* Effect.die(
              new Error(`'${options.id}': the AKS registry needs the cluster connection`),
            );
          }
          const auth = yield* narrowAksAuth(options.connection);
          const { subscriptionId, cluster } = yield* getLiveCluster(auth);
          const kubeletObjectId =
            cluster.properties?.identityProfile?.["kubeletidentity"]?.objectId;
          if (kubeletObjectId === undefined) {
            return yield* new AksClusterNotReady({
              message: `AKS cluster '${auth.clusterName}' has no kubelet identity`,
            });
          }
          yield* ensureRegistered(subscriptionId, "Microsoft.ContainerRegistry");

          const program = yield* bundleProgram({
            main: source.main,
            build: source.build,
            isExternal: options.isExternal,
            bootstrap: options.bootstrap,
          });

          // Observe → ensure the workload's registry.
          const resourceGroup =
            previous.subscriptionId === subscriptionId && previous.resourceGroup !== undefined
              ? previous.resourceGroup
              : auth.resourceGroup;
          const registryName =
            previous.registryName ?? (yield* createRegistryName(`${options.id}-registry`));
          const where = { subscriptionId, resourceGroupName: resourceGroup, registryName };
          const get = getRegistry(subscriptionId, resourceGroup, registryName);
          let registry = yield* get;
          if (registry === undefined) {
            yield* options.session.note(`Creating container registry ${registryName}`);
            yield* containerregistry.CreateRegistry({
              ...where,
              location: cluster.location,
              sku: { name: "Basic" },
              tags: options.tags,
              properties: { adminUserEnabled: false },
            });
          } else if (tagsDiffer(registry.tags, options.tags)) {
            yield* containerregistry.UpdateRegistry({ ...where, tags: options.tags });
          }
          registry = yield* waitForProvisioned(
            `container registry ${registryName}`,
            get,
            (r) => r.properties?.provisioningState,
            { interval: "3 seconds", times: 60 },
          );
          const registryId = registry.id ?? "";
          const loginServer = registry.properties?.loginServer ?? `${registryName}.azurecr.io`;

          // Let the cluster's kubelet pull from it.
          const pullAssignmentName = yield* deterministicGuid(
            options.id,
            `${registryId.toLowerCase()}|${kubeletObjectId}|acrpull`,
          );
          const pull = yield* orUndefinedIfNotFound(
            authorization.GetRoleAssignment({
              scope: registryId,
              roleAssignmentName: pullAssignmentName,
            }),
          );
          if (pull === undefined) {
            const marker = yield* ownershipMarker(`${options.id}#registry`);
            yield* authorization
              .CreateRoleAssignment({
                scope: registryId,
                roleAssignmentName: pullAssignmentName,
                properties: {
                  roleDefinitionId: roleDefinitionIdOf(subscriptionId, ACR_PULL_ROLE),
                  principalId: kubeletObjectId,
                  principalType: "ServicePrincipal",
                  description: descriptionWithMarker("Alchemy: AKS kubelet image pulls", marker),
                },
              })
              .pipe(Effect.catchTag("RoleAssignmentExists", () => Effect.void));
          }
          // A registry moved to another resource group or subscription.
          if (
            previous.registryName !== undefined &&
            (previous.registryName !== registryName ||
              previous.resourceGroup !== resourceGroup ||
              previous.subscriptionId !== subscriptionId)
          ) {
            yield* deleteRegistry(previous);
          }

          yield* options.session.note(
            `Pushing ${loginServer}/${IMAGE_REPOSITORY}:${program.codeHash}`,
          );
          const imageUri = yield* pushProgramImage({
            subscriptionId,
            resourceGroup,
            registryName,
            loginServer,
            repository: IMAGE_REPOSITORY,
            tag: program.codeHash,
            baseImage: DEFAULT_BASE_IMAGE,
            files: program.files,
            entrypoint: ["/app/index.mjs"],
          });
          return {
            imageUri,
            codeHash: program.codeHash,
            state: {
              kind: "azure-container-registry" as const,
              subscriptionId,
              resourceGroup,
              registryName,
              loginServer,
              registryId,
              pullAssignmentName,
            },
          } satisfies ImageRegistryResult;
        }).pipe(withAzure);

      const registryHash = (
        options: ImageRegistryHashOptions,
      ): Effect.Effect<string | undefined, any, AdapterLifecycleServices> =>
        Effect.gen(function* () {
          const source = options.source;
          if (source.main !== undefined) {
            const program = yield* bundleProgram({
              main: source.main,
              build: source.build,
              isExternal: options.isExternal,
              bootstrap: options.bootstrap,
            });
            return program.codeHash;
          }
          if (source.image !== undefined) {
            return yield* staticImageHash(source.image, options.platform);
          }
          return undefined;
        }).pipe(withAzure);

      const registryDelete = (
        options: ImageRegistryDeleteOptions,
      ): Effect.Effect<void, any, AdapterLifecycleServices> =>
        deleteRegistry(registryStateOf(options.state)).pipe(withAzure);

      return {
        kind: "Kubernetes.ClusterAdapter" as const,
        connect,
        identity: {
          reconcile: identityReconcile,
          delete: identityDelete,
        },
        registry: {
          resolve: registryResolve,
          hash: registryHash,
          delete: registryDelete,
        },
        bootstrap: {
          server: makeAksServerBootstrap,
          job: makeAksJobBootstrap,
        },
      } satisfies ClusterAdapterService;
    }),
  );
