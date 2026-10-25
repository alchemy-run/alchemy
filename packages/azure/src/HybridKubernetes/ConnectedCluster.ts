import * as hk from "@distilled.cloud/azure/hybridkubernetes";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

export interface ConnectedClusterAadProfile {
  /**
   * Use Azure RBAC for Kubernetes authorization.
   * @default false
   */
  enableAzureRBAC?: boolean;
  /**
   * Object IDs of Microsoft Entra groups granted cluster admin.
   * @default []
   */
  adminGroupObjectIDs?: string[];
  /**
   * Microsoft Entra tenant used for authentication.
   * @default the tenant of the subscription
   */
  tenantID?: string;
}

export interface ConnectedClusterArcAgentProfile {
  /**
   * Arc agent version to install on the cluster.
   * @default the latest version
   */
  desiredAgentVersion?: string;
  /**
   * Whether the Arc agents upgrade automatically to the latest version.
   * @default "Enabled"
   */
  agentAutoUpgrade?: "Enabled" | "Disabled";
}

export interface ConnectedClusterOidcIssuerProfile {
  /**
   * Enable the OIDC issuer for workload identity.
   * @default false
   */
  enabled?: boolean;
  /**
   * Issuer URL of a public-cloud cluster (AKS, EKS, GKE) that already
   * hosts its own OIDC issuer.
   * @default unset (Azure hosts the issuer)
   */
  selfHostedIssuerUrl?: string;
}

export interface ConnectedClusterProps {
  /**
   * Resource group the connected cluster is registered in. Changing it
   * replaces the cluster.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the connected cluster, 1-63 letters, digits, `-` and `_`,
   * starting and ending with a letter or digit. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the cluster.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the connected cluster. Changing it replaces the
   * cluster.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Base64-encoded DER RSA public key the Arc agents use for their initial
   * handshake with Azure. The onboarding tool (`az connectedk8s connect`)
   * generates the key pair and installs the private key with the agents.
   * Required. Changing it replaces the cluster.
   */
  agentPublicKeyCertificate: string;
  /**
   * Identity type of the cluster. Changing it replaces the cluster.
   * @default "SystemAssigned"
   */
  identityType?: "SystemAssigned" | "None";
  /**
   * Kind of connected cluster, e.g. `ProvisionedCluster` for clusters
   * provisioned by Azure (AKS on Azure Local). Omit for a regular Arc
   * cluster. Changing it replaces the cluster.
   * @default unset (a regular Arc cluster)
   */
  kind?: string;
  /**
   * Kubernetes distribution running on the cluster, e.g. `k3s`, `kind`, or
   * `generic`.
   * @default unset (the agents report it on connect)
   */
  distribution?: string;
  /**
   * Version of the Kubernetes distribution.
   * @default unset
   */
  distributionVersion?: string;
  /**
   * Infrastructure the cluster runs on, e.g. `generic` or `azure_stack_hci`.
   * @default unset (the agents report it on connect)
   */
  infrastructure?: string;
  /**
   * Opt in to Azure Hybrid Benefit (`True`, `False`, `NotApplicable`).
   * @default unset
   */
  azureHybridBenefit?: "True" | "False" | "NotApplicable";
  /**
   * Whether the cluster connects to Azure over a private link.
   * @default unset (public endpoints)
   */
  privateLinkState?: "Enabled" | "Disabled";
  /**
   * ARM ID of the Arc private link scope the cluster is assigned to. Only
   * used when `privateLinkState` is `Enabled`.
   * @default unset
   */
  privateLinkScopeResourceId?: string;
  /**
   * Microsoft Entra integration for the cluster. Azure rejects it with
   * "Internal failure" until the Arc agents have connected.
   * @default unset (no Entra integration)
   */
  aadProfile?: ConnectedClusterAadProfile;
  /**
   * Arc agent version and auto-upgrade settings.
   * @default the latest agents, upgraded automatically
   */
  arcAgentProfile?: ConnectedClusterArcAgentProfile;
  /**
   * Enable the workload identity webhook.
   * @default false
   */
  workloadIdentity?: boolean;
  /**
   * OIDC issuer settings for workload identity. Once enabled, the OIDC
   * issuer cannot be disabled again.
   * @default unset (no OIDC issuer)
   */
  oidcIssuerProfile?: ConnectedClusterOidcIssuerProfile;
  /**
   * Enable the gateway used by the Arc router for connectivity.
   * @default false
   */
  gatewayEnabled?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface ConnectedCluster extends Resource<
  "Azure.HybridKubernetes.ConnectedCluster",
  ConnectedClusterProps,
  {
    /** Name of the connected cluster. */
    clusterName: string;
    /** ARM resource ID of the connected cluster. */
    clusterId: string;
    /** Resource group that holds the connected cluster. */
    resourceGroup: string;
    /** Location of the connected cluster. */
    location: string;
    /** Kind of connected cluster, if any. */
    kind: string | undefined;
    /** Base64 agent public key the cluster was registered with. */
    agentPublicKeyCertificate: string;
    /** Identity type of the cluster. */
    identityType: string;
    /** Object ID of the cluster's system-assigned identity, if any. */
    principalId: string | undefined;
    /** Tenant of the cluster's system-assigned identity, if any. */
    tenantId: string | undefined;
    /** Provisioning state of the ARM resource. */
    provisioningState: string | undefined;
    /**
     * Connectivity of the Arc agents: `Connecting` until agents onboard,
     * then `Connected`, `Offline`, or `Expired`.
     */
    connectivityStatus: string | undefined;
    /** Version of the Arc agents reported by the cluster. */
    agentVersion: string | undefined;
    /** Kubernetes version reported by the cluster. */
    kubernetesVersion: string | undefined;
    /** Number of nodes reported by the cluster. */
    totalNodeCount: number | undefined;
    /** Kubernetes distribution of the cluster. */
    distribution: string | undefined;
    /** Infrastructure the cluster runs on. */
    infrastructure: string | undefined;
    /** OIDC issuer URL when the OIDC issuer is enabled. */
    oidcIssuerUrl: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc-enabled Kubernetes cluster
 * (`Microsoft.Kubernetes/connectedClusters`): the ARM record of a
 * Kubernetes cluster running anywhere (on-premises, edge, or another
 * cloud). Registering the resource reserves the identity. The cluster
 * connects once the Arc agents are installed with the private key matching
 * `agentPublicKeyCertificate` (normally by `az connectedk8s connect`).
 *
 * @see https://learn.microsoft.com/azure/azure-arc/kubernetes/overview
 *
 * ### Registering a Cluster
 * **Example:** Connected cluster for a k3s cluster
 * ```typescript
 * // base64 DER RSA public key of the agents' key pair
 * const agentPublicKey = "MIICCgKCAgEAyH6w...";
 * const cluster = yield* Azure.HybridKubernetes.ConnectedCluster("store-42", {
 *   agentPublicKeyCertificate: agentPublicKey,
 *   distribution: "k3s",
 *   infrastructure: "generic",
 * });
 * ```
 *
 * ### Microsoft Entra Integration
 * Azure accepts an `aadProfile` only after the Arc agents have connected.
 *
 * **Example:** Azure RBAC with an admin group
 * ```typescript
 * const agentPublicKey = "MIICCgKCAgEAyH6w...";
 * const adminGroupId = "5f8c2b1e-0d3a-4c7e-9b6f-2a1d4e8c7b90";
 * const cluster = yield* Azure.HybridKubernetes.ConnectedCluster("store-42", {
 *   agentPublicKeyCertificate: agentPublicKey,
 *   aadProfile: {
 *     enableAzureRBAC: true,
 *     adminGroupObjectIDs: [adminGroupId],
 *   },
 * });
 * ```
 *
 * ### Workload Identity
 * **Example:** OIDC issuer and workload identity webhook
 * ```typescript
 * const agentPublicKey = "MIICCgKCAgEAyH6w...";
 * const cluster = yield* Azure.HybridKubernetes.ConnectedCluster("store-42", {
 *   agentPublicKeyCertificate: agentPublicKey,
 *   oidcIssuerProfile: { enabled: true },
 *   workloadIdentity: true,
 * });
 * ```
 *
 * :::caution
 * Changing `name`, `location`, `resourceGroup`, `agentPublicKeyCertificate`,
 * `identityType`, or `kind` replaces the cluster record. The Arc agents on
 * the cluster must then be onboarded again with the new key.
 * :::
 *
 * @resource
 */
export const ConnectedCluster = GroupedResource<ConnectedCluster>(
  "Azure.HybridKubernetes.ConnectedCluster",
);

type ObservedCluster = hk.GetConnectedClusterResponse;

const createClusterName = (id: string) => createPhysicalName({ id, maxLength: 63 });

const getCluster = (subscriptionId: string, resourceGroupName: string, clusterName: string) =>
  orUndefinedIfNotFound(hk.GetConnectedCluster({ subscriptionId, resourceGroupName, clusterName }));

const toAttrs = (
  resourceGroup: string,
  name: string,
  cluster: ObservedCluster,
): ConnectedCluster["Attributes"] => ({
  clusterName: name,
  clusterId: cluster.id ?? "",
  resourceGroup,
  location: cluster.location,
  kind: cluster.kind,
  agentPublicKeyCertificate: cluster.properties.agentPublicKeyCertificate,
  identityType: cluster.identity.type,
  principalId: cluster.identity.principalId,
  tenantId: cluster.identity.tenantId,
  provisioningState: cluster.properties.provisioningState,
  connectivityStatus: cluster.properties.connectivityStatus,
  agentVersion: cluster.properties.agentVersion,
  kubernetesVersion: cluster.properties.kubernetesVersion,
  totalNodeCount: cluster.properties.totalNodeCount,
  distribution: cluster.properties.distribution,
  infrastructure: cluster.properties.infrastructure,
  oidcIssuerUrl: cluster.properties.oidcIssuerProfile?.issuerUrl,
  tags: userTags(cluster.tags),
});

const lower = (value: string | undefined) => value?.toLowerCase();

/** A user-set value differs from the observed one. */
const differs = <A>(desired: A | undefined, observed: A | undefined) =>
  desired !== undefined && desired !== observed;

const sameSet = (a: readonly string[], b: readonly string[] | undefined) => {
  const left = new Set(a.map((x) => x.toLowerCase()));
  const right = new Set((b ?? []).map((x) => x.toLowerCase()));
  return left.size === right.size && [...left].every((x) => right.has(x));
};

/**
 * Settings only the full PUT can change. The PATCH body accepts just
 * distribution, version, hybrid benefit, gateway and tags, and it refuses
 * distribution changes that involve a verified distribution (e.g. `k3s`),
 * which PUT accepts.
 */
const putOnlyDrift = (news: ConnectedClusterProps, observed: ObservedCluster) => {
  const props = observed.properties;
  const aad = news.aadProfile;
  const agent = news.arcAgentProfile;
  const oidc = news.oidcIssuerProfile;
  return (
    differs(news.distribution, props.distribution) ||
    differs(news.infrastructure, props.infrastructure) ||
    differs(news.privateLinkState, props.privateLinkState) ||
    (news.privateLinkScopeResourceId !== undefined &&
      lower(news.privateLinkScopeResourceId) !== lower(props.privateLinkScopeResourceId)) ||
    (aad !== undefined &&
      (differs(aad.enableAzureRBAC, props.aadProfile?.enableAzureRBAC) ||
        differs(aad.tenantID, props.aadProfile?.tenantID) ||
        (aad.adminGroupObjectIDs !== undefined &&
          !sameSet(aad.adminGroupObjectIDs, props.aadProfile?.adminGroupObjectIDs)))) ||
    (agent !== undefined &&
      (differs(agent.desiredAgentVersion, props.arcAgentProfile?.desiredAgentVersion) ||
        differs(agent.agentAutoUpgrade, props.arcAgentProfile?.agentAutoUpgrade))) ||
    differs(news.workloadIdentity, props.securityProfile?.workloadIdentity?.enabled) ||
    (oidc !== undefined &&
      (differs(oidc.enabled, props.oidcIssuerProfile?.enabled) ||
        differs(oidc.selfHostedIssuerUrl, props.oidcIssuerProfile?.selfHostedIssuerUrl)))
  );
};

/**
 * Full PUT body. A PUT replaces the whole configuration and Azure refuses
 * to reset some settings (an enabled OIDC issuer cannot be disabled), so
 * settings the props leave unset carry over from the observed cluster.
 */
const putProperties = (
  news: ConnectedClusterProps,
  observed: ObservedCluster | undefined,
): hk.ConnectedClusterPropertiesInput => {
  const current = observed?.properties;
  const agent = current?.arcAgentProfile;
  return {
    agentPublicKeyCertificate: news.agentPublicKeyCertificate,
    distribution: news.distribution ?? current?.distribution,
    distributionVersion: news.distributionVersion ?? current?.distributionVersion,
    infrastructure: news.infrastructure ?? current?.infrastructure,
    azureHybridBenefit: news.azureHybridBenefit ?? current?.azureHybridBenefit,
    privateLinkState: news.privateLinkState ?? current?.privateLinkState,
    privateLinkScopeResourceId:
      news.privateLinkScopeResourceId ?? current?.privateLinkScopeResourceId,
    aadProfile:
      news.aadProfile === undefined
        ? current?.aadProfile
        : { ...current?.aadProfile, ...news.aadProfile },
    arcAgentProfile:
      news.arcAgentProfile === undefined && agent === undefined
        ? undefined
        : {
            desiredAgentVersion:
              news.arcAgentProfile?.desiredAgentVersion ?? agent?.desiredAgentVersion,
            agentAutoUpgrade: news.arcAgentProfile?.agentAutoUpgrade ?? agent?.agentAutoUpgrade,
          },
    securityProfile:
      news.workloadIdentity === undefined
        ? current?.securityProfile
        : { workloadIdentity: { enabled: news.workloadIdentity } },
    oidcIssuerProfile:
      news.oidcIssuerProfile === undefined && current?.oidcIssuerProfile === undefined
        ? undefined
        : {
            enabled: news.oidcIssuerProfile?.enabled ?? current?.oidcIssuerProfile?.enabled,
            selfHostedIssuerUrl:
              news.oidcIssuerProfile?.selfHostedIssuerUrl ??
              current?.oidcIssuerProfile?.selfHostedIssuerUrl,
          },
    gateway:
      news.gatewayEnabled === undefined
        ? (current?.gateway ?? undefined)
        : { enabled: news.gatewayEnabled },
  };
};

const IN_FLIGHT = new Set(["Accepted", "Provisioning", "Updating"]);

/** A write raced the previous asynchronous PUT; wait for it to settle. */
const whileBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "ConnectedClusterOperationInProgress",
  schedule: Schedule.spaced("5 seconds"),
  times: 24,
} as const;

export const ConnectedClusterProvider = () =>
  Provider.succeed(ConnectedCluster, {
    stables: [
      "clusterName",
      "clusterId",
      "resourceGroup",
      "location",
      "kind",
      "agentPublicKeyCertificate",
      "identityType",
      "principalId",
      "tenantId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(hk.ListConnectedClusterBySubscription, { subscriptionId });
      return (page.value ?? []).flatMap((cluster) => {
        const group = resourceGroupOf(cluster.id);
        return hasAnyAlchemyTag(cluster.tags) && group !== undefined && cluster.name !== undefined
          ? [toAttrs(group, cluster.name, cluster)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && lower(news.name) !== lower(output.clusterName)) ||
        (news.location !== undefined && lower(news.location) !== lower(output.location)) ||
        news.agentPublicKeyCertificate !== output.agentPublicKeyCertificate ||
        (news.identityType ?? "SystemAssigned") !== output.identityType ||
        lower(news.kind) !== lower(output.kind)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its resource group.
      if (resourceGroup === undefined) return undefined;
      const name = output?.clusterName ?? olds?.name ?? (yield* createClusterName(id));
      const observed = yield* getCluster(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Kubernetes");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.clusterName ?? (yield* createClusterName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: name,
      };
      const label = `connected cluster ${name}`;
      const waitReady = waitForProvisioned(
        label,
        getCluster(subscriptionId, resourceGroup, name),
        (cluster) => cluster.properties.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Observe. Writes are refused while an earlier PUT is in flight.
      let observed = yield* getCluster(subscriptionId, resourceGroup, name);
      if (observed !== undefined && IN_FLIGHT.has(observed.properties.provisioningState ?? "")) {
        observed = yield* waitReady;
      }

      // Ensure. The PUT registers the full desired configuration; it is
      // also the only way to change the settings PATCH does not accept.
      if (observed === undefined || putOnlyDrift(news, observed)) {
        yield* hk
          .ConnectedClusterCreateOrReplace({
            ...where,
            location: observed?.location ?? location,
            tags,
            kind: news.kind,
            identity: { type: news.identityType ?? "SystemAssigned" },
            properties: putProperties(news, observed),
          })
          .pipe(Effect.retry(whileBusy));
      }
      observed = yield* waitReady;

      // Sync the PATCH-able aspects against observed state.
      const props = observed.properties;
      const patch: hk.ConnectedClusterPatchProperties = {};
      if (differs(news.distributionVersion, props.distributionVersion)) {
        patch.distributionVersion = news.distributionVersion;
      }
      if (differs(news.azureHybridBenefit, props.azureHybridBenefit)) {
        patch.azureHybridBenefit = news.azureHybridBenefit;
      }
      if (
        news.gatewayEnabled !== undefined &&
        news.gatewayEnabled !== (props.gateway?.enabled ?? false)
      ) {
        patch.gateway = { enabled: news.gatewayEnabled };
      }
      const propsChanged = Object.keys(patch).length > 0;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || tagsChanged) {
        yield* hk
          .UpdateConnectedCluster({
            ...where,
            tags: tagsChanged ? tags : undefined,
            properties: propsChanged ? patch : undefined,
          })
          .pipe(Effect.retry(whileBusy));
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hk
          .DeleteConnectedCluster({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            clusterName: output.clusterName,
          })
          .pipe(Effect.retry(whileBusy)),
      );
      yield* waitUntilGone(
        `connected cluster ${output.clusterName}`,
        getCluster(subscriptionId, output.resourceGroup, output.clusterName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
