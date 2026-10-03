import * as kc from "@distilled.cloud/azure/kubernetesconfiguration";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import {
  createChildName,
  sameName,
  subsetMatches,
} from "../ContainerService/Common.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  type ClusterRef,
  isHostOwned,
  parseClusterId,
  reveal,
  revealMap,
  sameSecrets,
} from "./Common.ts";

/** Git reference to check out. The most specific one set wins. */
export interface FluxRepositoryRef {
  /** Branch to check out. */
  branch?: string;
  /** Tag to check out (takes precedence over `branch`). */
  tag?: string;
  /** Semver range matched against tags (takes precedence over `tag`). */
  semver?: string;
  /** Commit SHA; must be combined with `branch`. */
  commit?: string;
}

/** A Git repository source. */
export interface FluxGitRepository {
  /** Repository URL (`https://`, `http://` or `ssh://`). */
  url: string;
  /** Reference to check out. */
  repositoryRef?: FluxRepositoryRef;
  /**
   * Maximum time to fetch the source, in seconds.
   * @default 600
   */
  timeoutInSeconds?: number;
  /**
   * Interval at which the source is re-fetched, in seconds.
   * @default 600
   */
  syncIntervalInSeconds?: number;
  /** Base64-encoded `known_hosts` for SSH repositories. */
  sshKnownHosts?: string;
  /** HTTPS user for private repositories (the key goes in the `httpsKey` protected setting). */
  httpsUser?: string;
  /** Base64-encoded HTTPS CA certificate. */
  httpsCACert?: string;
  /** Name of a Kubernetes secret on the cluster holding the credentials. */
  localAuthRef?: string;
}

/** An S3-compatible bucket source. */
export interface FluxBucket {
  /** Bucket endpoint URL. */
  url: string;
  /** Bucket name. */
  bucketName: string;
  /**
   * Use plain HTTP.
   * @default false
   */
  insecure?: boolean;
  /**
   * Maximum time to fetch the source, in seconds.
   * @default 600
   */
  timeoutInSeconds?: number;
  /**
   * Interval at which the source is re-fetched, in seconds.
   * @default 600
   */
  syncIntervalInSeconds?: number;
  /** Access key ID (the secret goes in the `bucketSecretKey` protected setting). */
  accessKey?: string;
  /** Name of a Kubernetes secret on the cluster holding the credentials. */
  localAuthRef?: string;
}

/** An Azure Blob Storage container source. */
export interface FluxAzureBlob {
  /** Blob service endpoint URL, e.g. `https://account.blob.core.windows.net`. */
  url: string;
  /** Container name. */
  containerName: string;
  /**
   * Maximum time to fetch the source, in seconds.
   * @default 600
   */
  timeoutInSeconds?: number;
  /**
   * Interval at which the source is re-fetched, in seconds.
   * @default 600
   */
  syncIntervalInSeconds?: number;
  /** Storage account key. Never returned by Azure. */
  accountKey?: string | Redacted.Redacted<string>;
  /** SAS token. Never returned by Azure. */
  sasToken?: string | Redacted.Redacted<string>;
  /** Client ID of a managed identity used to read the container. */
  managedIdentityClientId?: string;
  /** Service principal credentials. */
  servicePrincipal?: {
    /** Client ID. */
    clientId?: string;
    /** Tenant ID. */
    tenantId?: string;
    /** Client secret. Never returned by Azure. */
    clientSecret?: string | Redacted.Redacted<string>;
  };
  /** Name of a Kubernetes secret on the cluster holding the credentials. */
  localAuthRef?: string;
}

/** A Kustomization: a path in the source applied to the cluster. */
export interface FluxKustomization {
  /**
   * Path in the source to apply.
   * @default "" (repository root)
   */
  path?: string;
  /** Names of Kustomizations in this configuration that must reconcile first. */
  dependsOn?: string[];
  /**
   * Maximum time to apply, in seconds.
   * @default 600
   */
  timeoutInSeconds?: number;
  /**
   * Interval at which the Kustomization is re-applied, in seconds.
   * @default 600
   */
  syncIntervalInSeconds?: number;
  /** Retry interval after a failed apply, in seconds. */
  retryIntervalInSeconds?: number;
  /**
   * Delete objects removed from the source (and on deletion).
   * @default false
   */
  prune?: boolean;
  /**
   * Recreate objects when an immutable field changes.
   * @default false
   */
  force?: boolean;
  /**
   * Wait for applied objects to become healthy.
   * @default true
   */
  wait?: boolean;
  /** Variables substituted after `kustomize build`. */
  postBuildSubstitute?: Record<string, string>;
}

export interface FluxConfigurationProps {
  /**
   * ARM resource ID of the cluster (AKS managed cluster or Arc connected
   * cluster). The cluster needs the `microsoft.flux` extension installed.
   * Changing it replaces the configuration.
   */
  clusterId: string;
  /**
   * Configuration name: lowercase letters, digits, `-` and `.`. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the configuration.
   */
  name?: string;
  /**
   * Whether the configuration may manage objects cluster-wide or only in
   * `namespace`. Changing it replaces the configuration.
   * @default "cluster"
   */
  scope?: "cluster" | "namespace";
  /**
   * Namespace the Flux source and Kustomization objects are created in.
   * Changing it replaces the configuration.
   * @default "default"
   */
  namespace?: string;
  /**
   * Source to pull manifests from.
   * @default "GitRepository"
   */
  sourceKind?: "GitRepository" | "Bucket" | "AzureBlob";
  /** Git repository source (with `sourceKind: "GitRepository"`). */
  gitRepository?: FluxGitRepository;
  /** S3-compatible bucket source (with `sourceKind: "Bucket"`). */
  bucket?: FluxBucket;
  /** Azure Blob source (with `sourceKind: "AzureBlob"`). */
  azureBlob?: FluxAzureBlob;
  /** Kustomizations to apply, keyed by name. */
  kustomizations?: Record<string, FluxKustomization>;
  /**
   * Sensitive settings, e.g. `sshPrivateKey`, `httpsKey`,
   * `bucketSecretKey`. Azure never returns them, so they are re-sent
   * whenever their values change from the last deploy.
   */
  configurationProtectedSettings?: Record<
    string,
    string | Redacted.Redacted<string>
  >;
  /**
   * Suspend reconciliation of the sources and Kustomizations.
   * @default false
   */
  suspend?: boolean;
  /**
   * Wait for the cluster to reconcile the Kustomizations before the
   * deployment reports success.
   * @default false
   */
  waitForReconciliation?: boolean;
  /**
   * Maximum time to wait for reconciliation, as an ISO 8601 duration (e.g.
   * `PT10M`).
   */
  reconciliationWaitDuration?: string;
}

export interface FluxConfiguration extends Resource<
  "Azure.KubernetesConfiguration.FluxConfiguration",
  FluxConfigurationProps,
  {
    /** Name of the configuration. */
    fluxConfigurationName: string;
    /** ARM resource ID of the configuration. */
    fluxConfigurationId: string;
    /** ARM resource ID of the hosting cluster. */
    clusterId: string;
    /** Resource group of the hosting cluster. */
    resourceGroup: string;
    /** Name of the hosting cluster. */
    clusterName: string;
    /** Scope of the configuration. */
    scope: string | undefined;
    /** Namespace of the Flux objects. */
    namespace: string | undefined;
    /** Source kind. */
    sourceKind: string | undefined;
    /** Whether reconciliation is suspended. */
    suspend: boolean | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** `Compliant`, `Non-Compliant`, `Pending`, `Suspended` or `Unknown`. */
    complianceState: string | undefined;
    /** Public SSH key Flux generated for the repository (add it as a deploy key). */
    repositoryPublicKey: string | undefined;
    /** Commit last synced from the source. */
    sourceSyncedCommitId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Flux v2 GitOps configuration: Flux on the cluster pulls manifests from
 * a Git repository, S3 bucket, or Azure Blob container and applies them
 * through Kustomizations.
 *
 * Requires the `microsoft.flux` cluster extension
 * (`Azure.KubernetesConfiguration.Extension`). Configurations cannot be
 * tagged; ownership follows the hosting AKS cluster's Alchemy tags.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/kubernetes/conceptual-gitops-flux2
 *
 * ### Syncing a Git Repository
 * **Example:** Apply a public repository to an AKS cluster
 * ```typescript
 * const flux = yield* Azure.KubernetesConfiguration.Extension("Flux", {
 *   clusterId: cluster.clusterId,
 *   extensionType: "microsoft.flux",
 * });
 * yield* Azure.KubernetesConfiguration.FluxConfiguration("Apps", {
 *   clusterId: flux.clusterId,
 *   namespace: "flux-apps",
 *   gitRepository: {
 *     url: "https://github.com/Azure/gitops-flux2-kustomize-helm-mt",
 *     repositoryRef: { branch: "main" },
 *   },
 *   kustomizations: {
 *     infra: { path: "./infrastructure", prune: true },
 *     apps: { path: "./apps/staging", dependsOn: ["infra"], prune: true },
 *   },
 * });
 * ```
 *
 * ### Private Sources
 * **Example:** Authenticate over HTTPS
 * ```typescript
 * yield* Azure.KubernetesConfiguration.FluxConfiguration("Private", {
 *   clusterId: flux.clusterId,
 *   gitRepository: {
 *     url: "https://github.com/acme/private-manifests",
 *     repositoryRef: { branch: "main" },
 *     httpsUser: "git",
 *   },
 *   configurationProtectedSettings: {
 *     httpsKey: Redacted.make(githubToken),
 *   },
 *   kustomizations: { app: { path: "./" } },
 * });
 * ```
 *
 * ### Pausing Reconciliation
 * **Example:** Suspend a configuration
 * ```typescript
 * yield* Azure.KubernetesConfiguration.FluxConfiguration("Apps", {
 *   clusterId: flux.clusterId,
 *   gitRepository: { url, repositoryRef: { branch: "main" } },
 *   kustomizations: { app: { path: "./" } },
 *   suspend: true,
 * });
 * ```
 *
 * @resource
 */
export const FluxConfiguration = Resource<FluxConfiguration>(
  "Azure.KubernetesConfiguration.FluxConfiguration",
);

type ObservedConfiguration = kc.GetFluxConfigurationResponse;

const createConfigurationName = (id: string) => createChildName(id, 30);

const getConfiguration = (
  subscriptionId: string,
  ref: ClusterRef,
  fluxConfigurationName: string,
) =>
  orUndefinedIfNotFound(
    kc.GetFluxConfiguration({ subscriptionId, ...ref, fluxConfigurationName }),
  );

const toAttrs = (
  clusterId: string,
  ref: ClusterRef,
  name: string,
  configuration: ObservedConfiguration,
): FluxConfiguration["Attributes"] => {
  const props = configuration.properties;
  return {
    fluxConfigurationName: name,
    fluxConfigurationId: configuration.id ?? "",
    clusterId,
    resourceGroup: ref.resourceGroupName,
    clusterName: ref.clusterName,
    scope: props?.scope,
    namespace: props?.namespace,
    sourceKind: props?.sourceKind,
    suspend: props?.suspend,
    provisioningState: props?.provisioningState,
    complianceState: props?.complianceState,
    repositoryPublicKey: props?.repositoryPublicKey ?? undefined,
    sourceSyncedCommitId: props?.sourceSyncedCommitId ?? undefined,
  };
};

const stateOf = (configuration: ObservedConfiguration) =>
  configuration.properties?.provisioningState;

const toAzureBlob = (
  blob: FluxAzureBlob | undefined,
): kc.AzureBlobDefinition | undefined =>
  blob === undefined
    ? undefined
    : {
        url: blob.url,
        containerName: blob.containerName,
        timeoutInSeconds: blob.timeoutInSeconds,
        syncIntervalInSeconds: blob.syncIntervalInSeconds,
        accountKey:
          blob.accountKey === undefined ? undefined : reveal(blob.accountKey),
        sasToken:
          blob.sasToken === undefined ? undefined : reveal(blob.sasToken),
        managedIdentity:
          blob.managedIdentityClientId === undefined
            ? undefined
            : { clientId: blob.managedIdentityClientId },
        servicePrincipal:
          blob.servicePrincipal === undefined
            ? undefined
            : {
                clientId: blob.servicePrincipal.clientId,
                tenantId: blob.servicePrincipal.tenantId,
                clientSecret:
                  blob.servicePrincipal.clientSecret === undefined
                    ? undefined
                    : reveal(blob.servicePrincipal.clientSecret),
              },
        localAuthRef: blob.localAuthRef,
      };

const toKustomizations = (
  kustomizations: Record<string, FluxKustomization> | undefined,
): Record<string, kc.KustomizationDefinitionInput> =>
  Object.fromEntries(
    Object.entries(kustomizations ?? {}).map(([name, k]) => [
      name,
      {
        path: k.path,
        dependsOn: k.dependsOn,
        timeoutInSeconds: k.timeoutInSeconds,
        syncIntervalInSeconds: k.syncIntervalInSeconds,
        retryIntervalInSeconds: k.retryIntervalInSeconds,
        prune: k.prune,
        force: k.force,
        wait: k.wait,
        postBuild:
          k.postBuildSubstitute === undefined
            ? undefined
            : { substitute: k.postBuildSubstitute },
      },
    ]),
  );

/** Full PUT body for the desired configuration. */
const toProperties = (
  news: FluxConfigurationProps,
): kc.FluxConfigurationsCreateOrUpdateRequestProperties => ({
  scope: news.scope ?? "cluster",
  namespace: news.namespace ?? "default",
  sourceKind: news.sourceKind ?? "GitRepository",
  suspend: news.suspend ?? false,
  gitRepository: news.gitRepository,
  bucket: news.bucket,
  azureBlob: toAzureBlob(news.azureBlob),
  kustomizations: toKustomizations(news.kustomizations),
  configurationProtectedSettings: revealMap(
    news.configurationProtectedSettings,
  ),
  waitForReconciliation: news.waitForReconciliation,
  reconciliationWaitDuration: news.reconciliationWaitDuration,
});

/** Secret values Azure never returns; compared against the last deploy. */
const secretsOf = (
  props: FluxConfigurationProps | undefined,
): Record<string, string | Redacted.Redacted<string>> => {
  const secrets: Record<string, string | Redacted.Redacted<string>> = {
    ...props?.configurationProtectedSettings,
  };
  const blob = props?.azureBlob;
  if (blob?.accountKey !== undefined) secrets["@accountKey"] = blob.accountKey;
  if (blob?.sasToken !== undefined) secrets["@sasToken"] = blob.sasToken;
  if (blob?.servicePrincipal?.clientSecret !== undefined) {
    secrets["@clientSecret"] = blob.servicePrincipal.clientSecret;
  }
  return secrets;
};

/** Whether the observed configuration matches the desired non-secret state. */
const inSync = (
  news: FluxConfigurationProps,
  observed: ObservedConfiguration,
) => {
  const props = observed.properties;
  const desired = toProperties(news);
  const blob = desired.azureBlob;
  const desiredBlob =
    blob == null
      ? blob
      : {
          ...blob,
          accountKey: undefined,
          sasToken: undefined,
          servicePrincipal:
            blob.servicePrincipal == null
              ? blob.servicePrincipal
              : { ...blob.servicePrincipal, clientSecret: undefined },
        };
  const desiredKustomizations = desired.kustomizations ?? {};
  const observedKustomizations = props?.kustomizations ?? {};
  return (
    sameName(desired.sourceKind, props?.sourceKind) &&
    (desired.suspend ?? false) === (props?.suspend ?? false) &&
    subsetMatches(desired.gitRepository, props?.gitRepository) &&
    subsetMatches(desired.bucket, props?.bucket) &&
    subsetMatches(desiredBlob, props?.azureBlob) &&
    // Kustomizations are a keyed set: no extra and no drifted entries.
    Object.keys(observedKustomizations).every(
      (name) => name in desiredKustomizations,
    ) &&
    subsetMatches(desiredKustomizations, observedKustomizations)
  );
};

export const FluxConfigurationProvider = () =>
  Provider.succeed(FluxConfiguration, {
    stables: [
      "fluxConfigurationName",
      "fluxConfigurationId",
      "clusterId",
      "resourceGroup",
      "clusterName",
    ],

    // Configurations live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.clusterId, output.clusterId) ||
        (news.name !== undefined &&
          news.name !== output.fluxConfigurationName) ||
        !sameName(news.scope ?? "cluster", output.scope ?? "cluster") ||
        !sameName(news.namespace ?? "default", output.namespace ?? "default")
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const clusterId = output?.clusterId ?? olds?.clusterId;
      if (clusterId === undefined) return undefined;
      const ref = yield* parseClusterId(clusterId);
      const name =
        output?.fluxConfigurationName ??
        olds?.name ??
        (yield* createConfigurationName(id));
      const observed = yield* getConfiguration(subscriptionId, ref, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(clusterId, ref, name, observed);
      return (yield* isHostOwned(subscriptionId, ref)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.KubernetesConfiguration",
      );
      const ref = yield* parseClusterId(news.clusterId);
      const name =
        news.name ??
        output?.fluxConfigurationName ??
        (yield* createConfigurationName(id));
      const get = getConfiguration(subscriptionId, ref, name);
      const waitReady = waitForProvisioned(
        `flux configuration ${ref.clusterName}/${name}`,
        get,
        stateOf,
        { interval: "10 seconds", times: 60 },
      );

      // Observe (letting an in-flight operation settle), then PUT the full
      // desired state when the configuration is missing, failed, drifted,
      // or its secrets changed since the last deploy.
      let observed = yield* get;
      if (
        observed !== undefined &&
        observed.properties?.provisioningState !== "Failed"
      ) {
        observed = yield* waitReady;
      }
      const secretsChanged =
        Object.keys(secretsOf(news)).length > 0 &&
        (olds === undefined || !sameSecrets(secretsOf(news), secretsOf(olds)));
      if (
        observed === undefined ||
        observed.properties?.provisioningState === "Failed" ||
        !inSync(news, observed) ||
        secretsChanged
      ) {
        yield* kc.FluxConfigurationsCreateOrUpdate({
          subscriptionId,
          ...ref,
          fluxConfigurationName: name,
          properties: toProperties(news),
        });
        observed = yield* waitReady;
      }
      return toAttrs(news.clusterId, ref, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref = yield* parseClusterId(output.clusterId);
      yield* ignoreNotFound(
        kc.DeleteFluxConfiguration({
          subscriptionId,
          ...ref,
          fluxConfigurationName: output.fluxConfigurationName,
        }),
      );
      yield* waitUntilGone(
        `flux configuration ${output.clusterName}/${output.fluxConfigurationName}`,
        getConfiguration(subscriptionId, ref, output.fluxConfigurationName),
        { interval: "10 seconds", times: 60 },
      );
    }),
  });
