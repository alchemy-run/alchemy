import * as aro from "@distilled.cloud/azure/redhatopenshift";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export type ClusterVisibility = "Public" | "Private";

export interface ClusterServicePrincipal {
  /** Application (client) ID of the cluster's Microsoft Entra service principal. */
  clientId: string;
  /**
   * Client secret of the service principal. Changing it rotates the
   * cluster's credentials in place.
   */
  clientSecret: Redacted.Redacted<string>;
}

export interface ClusterMasterProfile {
  /** ARM ID of the control-plane subnet. Changing it replaces the cluster. */
  subnetId: string;
  /**
   * VM size of the three control-plane nodes. Changing it replaces the
   * cluster.
   * @default "Standard_D8s_v5"
   */
  vmSize?: string;
  /**
   * Encrypt the control-plane VM disks at host. Changing it replaces the
   * cluster.
   * @default false
   */
  encryptionAtHost?: boolean;
  /**
   * ARM ID of a disk encryption set for the control-plane disks. Changing it
   * replaces the cluster.
   */
  diskEncryptionSetId?: string;
}

export interface ClusterWorkerProfile {
  /** ARM ID of the worker subnet. Changing it replaces the cluster. */
  subnetId: string;
  /**
   * Name of the initial worker profile (machine set prefix). Changing it
   * replaces the cluster.
   * @default "worker"
   */
  name?: string;
  /**
   * VM size of the workers. Changing it replaces the cluster.
   * @default "Standard_D4s_v5"
   */
  vmSize?: string;
  /**
   * OS disk size of each worker in GB (minimum 128). Changing it replaces
   * the cluster.
   * @default 128
   */
  diskSizeGB?: number;
  /**
   * Number of initial workers (minimum 3). Scale an existing cluster with
   * OpenShift MachineSets; changing it here replaces the cluster.
   * @default 3
   */
  count?: number;
  /**
   * Encrypt the worker VM disks at host. Changing it replaces the cluster.
   * @default false
   */
  encryptionAtHost?: boolean;
  /**
   * ARM ID of a disk encryption set for the worker disks. Changing it
   * replaces the cluster.
   */
  diskEncryptionSetId?: string;
}

export interface ClusterNetworkProfile {
  /**
   * CIDR for pod IPs. Changing it replaces the cluster.
   * @default "10.128.0.0/14"
   */
  podCidr?: string;
  /**
   * CIDR for service IPs. Changing it replaces the cluster.
   * @default "172.30.0.0/16"
   */
  serviceCidr?: string;
  /**
   * Egress strategy. `UserDefinedRouting` requires private API server and
   * ingress visibility. Changing it replaces the cluster.
   * @default "Loadbalancer"
   */
  outboundType?: "Loadbalancer" | "UserDefinedRouting";
  /**
   * Use network security groups already attached to the subnets instead of
   * ARO-managed ones. Changing it replaces the cluster.
   * @default false
   */
  preconfiguredNsg?: boolean;
  /**
   * Number of managed outbound public IPs (1-20) on the cluster's public
   * load balancer. Mutable in place.
   * @default Azure's default (1)
   */
  managedOutboundIpCount?: number;
}

export interface ClusterProps {
  /** Resource group the cluster is created in. Changing it replaces the cluster. */
  resourceGroup: string;
  /**
   * Cluster name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the cluster.
   */
  name?: string;
  /**
   * Azure location of the cluster. Changing it replaces the cluster.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Cluster domain: either a short prefix (the cluster is served under
   * `{domain}.{location}.aroapp.io`) or a custom FQDN you own. Changing it
   * replaces the cluster.
   * @default a unique 10-character prefix derived from the instance
   */
  domain?: string;
  /**
   * OpenShift version to install (see `ListOpenShiftVersions`). Only used at
   * creation: upgrades happen inside the cluster, so later changes are
   * ignored.
   * @default the RP's default version
   */
  version?: string;
  /**
   * Red Hat pull secret (JSON from console.redhat.com) that unlocks Red Hat
   * registries and OperatorHub content. Only used at creation.
   */
  pullSecret?: Redacted.Redacted<string>;
  /**
   * Name of the cluster-managed resource group that ARO creates for the
   * cluster's VMs, disks, and load balancers. It must not exist yet.
   * Changing it replaces the cluster.
   * @default `aro-{domain}`
   */
  managedResourceGroup?: string;
  /**
   * Use FIPS-validated cryptographic modules. Changing it replaces the
   * cluster.
   * @default false
   */
  fipsValidatedModules?: boolean;
  /**
   * Service principal the cluster uses to manage Azure resources. It needs
   * Network Contributor on the virtual network. Mutually exclusive with
   * `platformWorkloadIdentities`.
   */
  servicePrincipal?: ClusterServicePrincipal;
  /**
   * ARM ID of the user-assigned managed identity of a workload identity
   * cluster. Required with `platformWorkloadIdentities`. Mutable in place.
   */
  clusterIdentityId?: string;
  /**
   * Operator name → ARM ID of the user-assigned managed identity each
   * OpenShift platform operator uses (workload identity clusters; see
   * `ListPlatformWorkloadIdentityRoleSets` for the required operators).
   * Mutable in place.
   */
  platformWorkloadIdentities?: Record<string, string>;
  /**
   * OpenShift version a workload identity cluster is prepared to upgrade
   * to. Mutable in place.
   */
  upgradeableTo?: string;
  /** Control-plane nodes. */
  master: ClusterMasterProfile;
  /** Initial worker nodes. */
  worker: ClusterWorkerProfile;
  /** Cluster networking. */
  network?: ClusterNetworkProfile;
  /**
   * API server visibility. Changing it replaces the cluster.
   * @default "Public"
   */
  apiServerVisibility?: ClusterVisibility;
  /**
   * Default ingress controller visibility. Changing it replaces the cluster.
   * @default "Public"
   */
  ingressVisibility?: ClusterVisibility;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "Azure.RedHatOpenShift.Cluster",
  ClusterProps,
  {
    /** Name of the cluster. */
    clusterName: string;
    /** ARM resource ID of the cluster. */
    clusterId: string;
    /** Resource group that holds the cluster. */
    resourceGroup: string;
    /** Location of the cluster. */
    location: string;
    /** Cluster domain. */
    domain: string | undefined;
    /** Installed OpenShift version. */
    version: string | undefined;
    /** ARM ID of the cluster-managed resource group. */
    managedResourceGroupId: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** URL of the Kubernetes API server. */
    apiServerUrl: string | undefined;
    /** IP of the Kubernetes API server. */
    apiServerIp: string | undefined;
    /** URL of the OpenShift web console. */
    consoleUrl: string | undefined;
    /** IP of the default ingress controller. */
    ingressIp: string | undefined;
    /** OIDC issuer URL of a workload identity cluster. */
    oidcIssuer: string | undefined;
    /** Username of the built-in `kubeadmin` user. */
    kubeadminUsername: string | undefined;
    /** Password of the built-in `kubeadmin` user. */
    kubeadminPassword: Redacted.Redacted<string> | undefined;
    /** Admin kubeconfig of the cluster. */
    kubeconfig: Redacted.Redacted<string> | undefined;
    /** Salted fingerprint of the last service principal secret Alchemy set. */
    servicePrincipalSecretFingerprint: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Red Hat OpenShift (ARO) cluster — a fully managed OpenShift
 * cluster jointly operated by Microsoft and Red Hat. ARO needs a virtual
 * network with two subnets (control plane and workers) and either a
 * service principal or platform workload identities, and at least 44
 * regional vCPUs of quota (3 × D8s control plane + 3 × D4s workers).
 * Creation takes 35-45 minutes.
 *
 * @see https://learn.microsoft.com/azure/openshift/intro-openshift
 *
 * ### Creating a Cluster
 * **Example:** Public cluster with a service principal
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("aro", {
 *   location: "eastus",
 * });
 * const vnet = yield* Azure.Network.VirtualNetwork("aro-vnet", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.0.0.0/22"],
 * });
 * const master = yield* Azure.Network.Subnet("master", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.0.0/23",
 * });
 * const worker = yield* Azure.Network.Subnet("worker", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.2.0/23",
 * });
 * const cluster = yield* Azure.RedHatOpenShift.Cluster("aro", {
 *   resourceGroup: group.resourceGroupName,
 *   servicePrincipal: {
 *     clientId: process.env.ARO_CLIENT_ID!,
 *     clientSecret: Redacted.make(process.env.ARO_CLIENT_SECRET!),
 *   },
 *   pullSecret: Redacted.make(process.env.ARO_PULL_SECRET!),
 *   master: { subnetId: master.subnetId },
 *   worker: { subnetId: worker.subnetId },
 * });
 * // cluster.consoleUrl, cluster.apiServerUrl, cluster.kubeconfig
 * ```
 *
 * **Example:** Private cluster with user-defined routing
 * ```typescript
 * const cluster = yield* Azure.RedHatOpenShift.Cluster("aro", {
 *   resourceGroup: group.resourceGroupName,
 *   servicePrincipal,
 *   master: { subnetId: master.subnetId },
 *   worker: { subnetId: worker.subnetId, count: 3 },
 *   network: { outboundType: "UserDefinedRouting" },
 *   apiServerVisibility: "Private",
 *   ingressVisibility: "Private",
 * });
 * ```
 *
 * ### Workload Identity
 * **Example:** Cluster with platform workload identities
 * ```typescript
 * const cluster = yield* Azure.RedHatOpenShift.Cluster("aro", {
 *   resourceGroup: group.resourceGroupName,
 *   version: "4.15.35",
 *   clusterIdentityId: clusterIdentity.identityId,
 *   platformWorkloadIdentities: {
 *     "cloud-controller-manager": ccm.identityId,
 *     ingress: ingress.identityId,
 *     // ...one identity per operator in the version's role set
 *   },
 *   master: { subnetId: master.subnetId },
 *   worker: { subnetId: worker.subnetId },
 * });
 * ```
 *
 * @resource
 */
export const Cluster = Resource<Cluster>("Azure.RedHatOpenShift.Cluster");

type ObservedCluster = aro.GetOpenShiftClusterResponse;

const lower = (value: string | undefined) => value?.toLowerCase();

const createClusterName = (id: string) =>
  createPhysicalName({ id, maxLength: 30, lowercase: true });

const createDomain = (id: string) =>
  createPhysicalName({
    id,
    prefix: "aro",
    suffixLength: 7,
    maxLength: 10,
    lowercase: true,
    delimiter: "",
  });

const getCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) =>
  orUndefinedIfNotFound(
    aro.GetOpenShiftCluster({
      subscriptionId,
      resourceGroupName,
      resourceName,
    }),
  );

const secretFingerprint = (
  salt: string,
  secret: Redacted.Redacted<string> | undefined,
) =>
  secret === undefined
    ? Effect.succeed(undefined)
    : Effect.sync(() =>
        Redacted.make(
          createHash("sha256")
            .update(`${salt}:${Redacted.value(secret)}`)
            .digest("hex"),
        ),
      );

const sameSecret = (
  a: Redacted.Redacted<string> | undefined,
  b: Redacted.Redacted<string> | undefined,
) =>
  a !== undefined && b !== undefined && Redacted.value(a) === Redacted.value(b);

const asRedacted = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? value
      : Redacted.make(value);

/**
 * Credentials only exist once the cluster has finished installing; a
 * cluster that is still creating or failed has none.
 */
const getCredentials = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  cluster: ObservedCluster,
) =>
  Effect.gen(function* () {
    if (cluster.properties?.provisioningState !== "Succeeded") {
      return {
        username: undefined,
        password: undefined,
        kubeconfig: undefined,
      };
    }
    const where = { subscriptionId, resourceGroupName, resourceName };
    const creds = yield* orUndefinedIfNotFound(
      aro.ListOpenShiftClusterCredentials(where),
    );
    const admin = yield* orUndefinedIfNotFound(
      aro.ListOpenShiftClusterAdminCredentials(where),
    );
    return {
      username: creds?.kubeadminUsername,
      password: asRedacted(creds?.kubeadminPassword),
      kubeconfig: asRedacted(admin?.kubeconfig),
    };
  });

const toAttrs = (
  resourceGroup: string,
  name: string,
  cluster: ObservedCluster | aro.OpenShiftCluster,
  credentials: {
    username: string | undefined;
    password: Redacted.Redacted<string> | undefined;
    kubeconfig: Redacted.Redacted<string> | undefined;
  },
  servicePrincipalSecretFingerprint: Redacted.Redacted<string> | undefined,
): Cluster["Attributes"] => {
  const props = cluster.properties;
  return {
    clusterName: name,
    clusterId: cluster.id ?? "",
    resourceGroup,
    location: cluster.location,
    domain: props?.clusterProfile?.domain,
    version: props?.clusterProfile?.version,
    managedResourceGroupId: props?.clusterProfile?.resourceGroupId,
    provisioningState: props?.provisioningState,
    apiServerUrl: props?.apiserverProfile?.url,
    apiServerIp: props?.apiserverProfile?.ip,
    consoleUrl: props?.consoleProfile?.url,
    ingressIp: props?.ingressProfiles?.[0]?.ip,
    oidcIssuer: props?.clusterProfile?.oidcIssuer,
    kubeadminUsername: credentials.username,
    kubeadminPassword: credentials.password,
    kubeconfig: credentials.kubeconfig,
    servicePrincipalSecretFingerprint,
    tags: userTags(cluster.tags),
  };
};

const enabled = (value: boolean | undefined) =>
  value ? ("Enabled" as const) : ("Disabled" as const);

const NO_CREDENTIALS = {
  username: undefined,
  password: undefined,
  kubeconfig: undefined,
};

const DEFAULT_POD_CIDR = "10.128.0.0/14";
const DEFAULT_SERVICE_CIDR = "172.30.0.0/16";

// Install takes 35-45 minutes; delete 20-30.
const CREATE_BUDGET = { interval: "60 seconds", times: 60 } as const;
const DELETE_BUDGET = { interval: "60 seconds", times: 45 } as const;

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: [
      "clusterName",
      "clusterId",
      "resourceGroup",
      "location",
      "domain",
      "managedResourceGroupId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* aro
        .ListOpenShiftClusters({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListOpenShiftClusters", page),
          ),
        );
      return (page.value ?? []).flatMap((cluster) => {
        const group = resourceGroupOf(cluster.id);
        return hasAnyAlchemyTag(cluster.tags) &&
          group !== undefined &&
          cluster.name !== undefined
          ? [toAttrs(group, cluster.name, cluster, NO_CREDENTIALS, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const replace = { action: "replace" } as const;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.clusterName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        (news.domain !== undefined &&
          lower(news.domain) !== lower(output.domain))
      ) {
        return replace;
      }
      if (
        news.managedResourceGroup !== undefined &&
        output.managedResourceGroupId !== undefined &&
        lower(resourceGroupOf(output.managedResourceGroupId)) !==
          lower(news.managedResourceGroup)
      ) {
        return replace;
      }
      if (olds === undefined) return undefined;
      const immutable = (props: ClusterProps) =>
        JSON.stringify({
          fips: props.fipsValidatedModules ?? false,
          master: {
            subnetId: lower(props.master.subnetId),
            vmSize: props.master.vmSize ?? "Standard_D8s_v5",
            encryptionAtHost: props.master.encryptionAtHost ?? false,
            diskEncryptionSetId: lower(props.master.diskEncryptionSetId),
          },
          worker: {
            subnetId: lower(props.worker.subnetId),
            name: props.worker.name ?? "worker",
            vmSize: props.worker.vmSize ?? "Standard_D4s_v5",
            diskSizeGB: props.worker.diskSizeGB ?? 128,
            count: props.worker.count ?? 3,
            encryptionAtHost: props.worker.encryptionAtHost ?? false,
            diskEncryptionSetId: lower(props.worker.diskEncryptionSetId),
          },
          podCidr: props.network?.podCidr ?? DEFAULT_POD_CIDR,
          serviceCidr: props.network?.serviceCidr ?? DEFAULT_SERVICE_CIDR,
          outboundType: props.network?.outboundType ?? "Loadbalancer",
          preconfiguredNsg: props.network?.preconfiguredNsg ?? false,
          apiServerVisibility: props.apiServerVisibility ?? "Public",
          ingressVisibility: props.ingressVisibility ?? "Public",
          servicePrincipal: props.servicePrincipal !== undefined,
          clientId: lower(props.servicePrincipal?.clientId),
        });
      if (immutable(news) !== immutable(olds)) return replace;
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.clusterName ?? olds?.name ?? (yield* createClusterName(id));
      const observed = yield* getCluster(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const credentials = yield* getCredentials(
        subscriptionId,
        resourceGroup,
        name,
        observed,
      );
      const attrs = toAttrs(
        resourceGroup,
        name,
        observed,
        credentials,
        output?.servicePrincipalSecretFingerprint,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.RedHatOpenShift");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.clusterName ?? (yield* createClusterName(id));
      const location = news.location ?? output?.location ?? env.location;
      const domain = news.domain ?? output?.domain ?? (yield* createDomain(id));
      const managedResourceGroupId =
        output?.managedResourceGroupId ??
        `/subscriptions/${subscriptionId}/resourceGroups/${
          news.managedResourceGroup ?? `aro-${domain}`
        }`;
      const tags = yield* desiredTags(id, news.tags);
      const fingerprint = yield* secretFingerprint(
        `${resourceGroup}/${name}`,
        news.servicePrincipal?.clientSecret,
      );
      const servicePrincipalProfile = news.servicePrincipal
        ? {
            clientId: news.servicePrincipal.clientId,
            clientSecret: Redacted.value(news.servicePrincipal.clientSecret),
          }
        : undefined;
      const platformWorkloadIdentityProfile =
        news.platformWorkloadIdentities !== undefined ||
        news.upgradeableTo !== undefined
          ? {
              upgradeableTo: news.upgradeableTo,
              platformWorkloadIdentities:
                news.platformWorkloadIdentities === undefined
                  ? undefined
                  : Object.fromEntries(
                      Object.entries(news.platformWorkloadIdentities).map(
                        ([operator, resourceId]) => [operator, { resourceId }],
                      ),
                    ),
            }
          : undefined;
      const identity =
        news.clusterIdentityId !== undefined
          ? {
              type: "UserAssigned" as const,
              userAssignedIdentities: { [news.clusterIdentityId]: {} },
            }
          : undefined;
      const managedOutboundIpCount = news.network?.managedOutboundIpCount;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: name,
      };
      const label = `OpenShift cluster ${name}`;
      const poll = getCluster(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* poll;

      // Ensure. The PUT is a long-running install (35-45 minutes).
      if (observed === undefined) {
        yield* aro.OpenShiftClustersCreateOrUpdate({
          ...where,
          location,
          tags,
          identity,
          properties: {
            clusterProfile: {
              domain,
              version: news.version,
              pullSecret:
                news.pullSecret === undefined
                  ? undefined
                  : Redacted.value(news.pullSecret),
              resourceGroupId: managedResourceGroupId,
              fipsValidatedModules: enabled(news.fipsValidatedModules),
            },
            servicePrincipalProfile,
            platformWorkloadIdentityProfile,
            networkProfile: {
              podCidr: news.network?.podCidr ?? DEFAULT_POD_CIDR,
              serviceCidr: news.network?.serviceCidr ?? DEFAULT_SERVICE_CIDR,
              outboundType: news.network?.outboundType ?? "Loadbalancer",
              preconfiguredNSG: enabled(news.network?.preconfiguredNsg),
              loadBalancerProfile:
                managedOutboundIpCount === undefined
                  ? undefined
                  : { managedOutboundIps: { count: managedOutboundIpCount } },
            },
            masterProfile: {
              vmSize: news.master.vmSize ?? "Standard_D8s_v5",
              subnetId: news.master.subnetId,
              encryptionAtHost: enabled(news.master.encryptionAtHost),
              diskEncryptionSetId: news.master.diskEncryptionSetId,
            },
            workerProfiles: [
              {
                name: news.worker.name ?? "worker",
                vmSize: news.worker.vmSize ?? "Standard_D4s_v5",
                diskSizeGB: news.worker.diskSizeGB ?? 128,
                subnetId: news.worker.subnetId,
                count: news.worker.count ?? 3,
                encryptionAtHost: enabled(news.worker.encryptionAtHost),
                diskEncryptionSetId: news.worker.diskEncryptionSetId,
              },
            ],
            apiserverProfile: {
              visibility: news.apiServerVisibility ?? "Public",
            },
            ingressProfiles: [
              {
                name: "default",
                visibility: news.ingressVisibility ?? "Public",
              },
            ],
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        poll,
        (cluster) => cluster.properties?.provisioningState,
        CREATE_BUDGET,
      );

      // Sync mutable aspects against observed state; PATCH only deltas.
      const props = observed.properties;
      const patch: aro.OpenShiftClusterPropertiesInput = {};
      if (
        servicePrincipalProfile !== undefined &&
        (lower(props?.servicePrincipalProfile?.clientId) !==
          lower(servicePrincipalProfile.clientId) ||
          !sameSecret(fingerprint, output?.servicePrincipalSecretFingerprint))
      ) {
        patch.servicePrincipalProfile = servicePrincipalProfile;
      }
      if (platformWorkloadIdentityProfile !== undefined) {
        const observedIdentities = Object.fromEntries(
          Object.entries(
            props?.platformWorkloadIdentityProfile
              ?.platformWorkloadIdentities ?? {},
          ).map(([operator, value]) => [operator, lower(value?.resourceId)]),
        );
        const desiredIdentities = Object.fromEntries(
          Object.entries(news.platformWorkloadIdentities ?? {}).map(
            ([operator, resourceId]) => [operator, lower(resourceId)],
          ),
        );
        const identitiesDiffer =
          news.platformWorkloadIdentities !== undefined &&
          (Object.keys(observedIdentities).length !==
            Object.keys(desiredIdentities).length ||
            Object.entries(desiredIdentities).some(
              ([operator, resourceId]) =>
                observedIdentities[operator] !== resourceId,
            ));
        const upgradeableToDiffers =
          news.upgradeableTo !== undefined &&
          props?.platformWorkloadIdentityProfile?.upgradeableTo !==
            news.upgradeableTo;
        if (identitiesDiffer || upgradeableToDiffers) {
          patch.platformWorkloadIdentityProfile =
            platformWorkloadIdentityProfile;
        }
      }
      if (
        managedOutboundIpCount !== undefined &&
        props?.networkProfile?.loadBalancerProfile?.managedOutboundIps
          ?.count !== managedOutboundIpCount
      ) {
        patch.networkProfile = {
          loadBalancerProfile: {
            managedOutboundIps: { count: managedOutboundIpCount },
          },
        };
      }
      const identityChanged =
        news.clusterIdentityId !== undefined &&
        !Object.keys(observed.identity?.userAssignedIdentities ?? {}).some(
          (key) => lower(key) === lower(news.clusterIdentityId),
        );
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(patch).length > 0 || identityChanged || tagsChanged) {
        yield* aro.UpdateOpenShiftCluster({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? identity : undefined,
          properties: Object.keys(patch).length > 0 ? patch : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          poll,
          (cluster) => cluster.properties?.provisioningState,
          CREATE_BUDGET,
        );
      }

      const credentials = yield* getCredentials(
        subscriptionId,
        resourceGroup,
        name,
        observed,
      );
      return toAttrs(resourceGroup, name, observed, credentials, fingerprint);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        aro.DeleteOpenShiftCluster({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.clusterName,
        }),
      );
      yield* waitUntilGone(
        `OpenShift cluster ${output.clusterName}`,
        getCluster(subscriptionId, output.resourceGroup, output.clusterName),
        DELETE_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
