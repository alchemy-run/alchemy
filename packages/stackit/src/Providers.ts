import { DockerLive } from "@alchemy.run/docker/Docker";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { StackitAuth } from "./AuthProvider.ts";
// ── ContainerRegistry imports ──
import {
  Project as ContainerRegistryProject,
  ProjectProvider as ContainerRegistryProjectProvider,
} from "./ContainerRegistry/Project.ts";
import { RobotAccount, RobotAccountProvider } from "./ContainerRegistry/RobotAccount.ts";
import * as Credentials from "./Credentials.ts";
// ── DNS imports ──
import { RecordSet, RecordSetProvider } from "./DNS/RecordSet.ts";
import { Zone, ZoneProvider } from "./DNS/Zone.ts";
import { environmentFromAuthProvider } from "./Environment.ts";
// ── Functions imports ──
import { Function as FunctionsFunction, FunctionProvider } from "./Functions/Function.ts";
import { PullCredential, PullCredentialProvider } from "./Functions/PullCredential.ts";
// ── IaaS imports ──
import { AffinityGroup, AffinityGroupProvider } from "./IaaS/AffinityGroup.ts";
import { Backup, BackupProvider } from "./IaaS/Backup.ts";
import { Image, ImageProvider } from "./IaaS/Image.ts";
import { ImageShare, ImageShareProvider } from "./IaaS/ImageShare.ts";
import { KeyPair, KeyPairProvider } from "./IaaS/KeyPair.ts";
import { Network, NetworkProvider } from "./IaaS/Network.ts";
import { NetworkArea, NetworkAreaProvider } from "./IaaS/NetworkArea.ts";
import { NetworkAreaRegion, NetworkAreaRegionProvider } from "./IaaS/NetworkAreaRegion.ts";
import { NetworkAreaRoute, NetworkAreaRouteProvider } from "./IaaS/NetworkAreaRoute.ts";
import { NetworkInterface, NetworkInterfaceProvider } from "./IaaS/NetworkInterface.ts";
import { PublicIp, PublicIpProvider } from "./IaaS/PublicIp.ts";
import { RoutingTable, RoutingTableProvider } from "./IaaS/RoutingTable.ts";
import { RoutingTableRoute, RoutingTableRouteProvider } from "./IaaS/RoutingTableRoute.ts";
import { SecurityGroup, SecurityGroupProvider } from "./IaaS/SecurityGroup.ts";
import { SecurityGroupRule, SecurityGroupRuleProvider } from "./IaaS/SecurityGroupRule.ts";
import { Server, ServerProvider } from "./IaaS/Server.ts";
import {
  ServerNetworkInterfaceAttachment,
  ServerNetworkInterfaceAttachmentProvider,
} from "./IaaS/ServerNetworkInterfaceAttachment.ts";
import {
  ServerSecurityGroupAttachment,
  ServerSecurityGroupAttachmentProvider,
} from "./IaaS/ServerSecurityGroupAttachment.ts";
import {
  ServerServiceAccountAttachment,
  ServerServiceAccountAttachmentProvider,
} from "./IaaS/ServerServiceAccountAttachment.ts";
import { Snapshot, SnapshotProvider } from "./IaaS/Snapshot.ts";
import { Volume, VolumeProvider } from "./IaaS/Volume.ts";
import { VolumeAttachment, VolumeAttachmentProvider } from "./IaaS/VolumeAttachment.ts";
// ── IAM imports ──
import { CustomRole, CustomRoleProvider } from "./IAM/CustomRole.ts";
import {
  FederatedIdentityProvider,
  FederatedIdentityProviderProvider,
} from "./IAM/FederatedIdentityProvider.ts";
import { Membership, MembershipProvider } from "./IAM/Membership.ts";
import { ServiceAccount, ServiceAccountProvider } from "./IAM/ServiceAccount.ts";
import { ServiceAccountKey, ServiceAccountKeyProvider } from "./IAM/ServiceAccountKey.ts";
// ── KMS imports ──
import { Key, KeyProvider } from "./KMS/Key.ts";
import { KeyRing, KeyRingProvider } from "./KMS/KeyRing.ts";
import { WrappingKey, WrappingKeyProvider } from "./KMS/WrappingKey.ts";
// ── LoadBalancer imports ──
import {
  LoadBalancer as NlbLoadBalancer,
  LoadBalancerProvider as NlbLoadBalancerProvider,
} from "./LoadBalancer/LoadBalancer.ts";
import {
  ObservabilityCredential as NlbObservabilityCredential,
  ObservabilityCredentialProvider as NlbObservabilityCredentialProvider,
} from "./LoadBalancer/ObservabilityCredential.ts";
// ── ObjectStorage imports ──
import { AccessKey, AccessKeyProvider } from "./ObjectStorage/AccessKey.ts";
import { Bucket, BucketProvider } from "./ObjectStorage/Bucket.ts";
import { ComplianceLock, ComplianceLockProvider } from "./ObjectStorage/ComplianceLock.ts";
import { CredentialsGroup, CredentialsGroupProvider } from "./ObjectStorage/CredentialsGroup.ts";
import {
  Project as ObjectStorageProject,
  ProjectProvider as ObjectStorageProjectProvider,
} from "./ObjectStorage/Project.ts";
// ── PostgresFlex imports ──
import {
  Database as PostgresFlexDatabase,
  DatabaseProvider as PostgresFlexDatabaseProvider,
} from "./PostgresFlex/Database.ts";
import {
  Instance as PostgresFlexInstance,
  InstanceProvider as PostgresFlexInstanceProvider,
} from "./PostgresFlex/Instance.ts";
import {
  User as PostgresFlexUser,
  UserProvider as PostgresFlexUserProvider,
} from "./PostgresFlex/User.ts";
// ── ResourceManager imports ──
import { Folder, FolderProvider } from "./ResourceManager/Folder.ts";
import { Organization, OrganizationProvider } from "./ResourceManager/Organization.ts";
import { Project, ProjectProvider } from "./ResourceManager/Project.ts";
// ── SecretsManager imports ──
import {
  AppRole as SecretsManagerAppRole,
  AppRoleProvider as SecretsManagerAppRoleProvider,
} from "./SecretsManager/AppRole.ts";
import {
  AppRoleSecretId as SecretsManagerAppRoleSecretId,
  AppRoleSecretIdProvider as SecretsManagerAppRoleSecretIdProvider,
} from "./SecretsManager/AppRoleSecretId.ts";
import {
  Instance as SecretsManagerInstance,
  InstanceProvider as SecretsManagerInstanceProvider,
} from "./SecretsManager/Instance.ts";
import {
  Secret as SecretsManagerSecret,
  SecretProvider as SecretsManagerSecretProvider,
} from "./SecretsManager/Secret.ts";
import {
  User as SecretsManagerUser,
  UserProvider as SecretsManagerUserProvider,
} from "./SecretsManager/User.ts";
// ── ServiceEnablement imports ──
import { Service, ServiceProvider } from "./ServiceEnablement/Service.ts";
// ── SKE imports ──
import { Cluster, ClusterProvider } from "./SKE/Cluster.ts";
import { Kubeconfig, KubeconfigProvider } from "./SKE/Kubeconfig.ts";
import { SkeKubernetesAdapter } from "./SKE/KubernetesAdapter.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Stackit") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/*
 * Registration: each namespace owns one resource list and one provider
 * group below. Add a resource class to its namespace's `*Resources` array
 * and its `*Provider()` layer to the matching `*Providers` group — single
 * line insertions, alphabetical within a group. Keep each group under ~90
 * entries (split into nested `Layer.mergeAll` calls beyond that): a flat
 * ~200-argument call exceeds tsc's variadic inference and silently drops
 * the tail layers from the inferred union. `Layer.empty` keeps an empty
 * group valid; leave it in place.
 */

const serviceEnablementResources = [Service];
const serviceEnablementProviders = () => Layer.mergeAll(Layer.empty, ServiceProvider());

// Replace `[] as const` with `[A, B]` when adding the first resource.
const resourceManagerResources = [Folder, Organization, Project];
const resourceManagerProviders = () =>
  Layer.mergeAll(Layer.empty, FolderProvider(), OrganizationProvider(), ProjectProvider());

const iamResources = [
  CustomRole,
  FederatedIdentityProvider,
  Membership,
  ServiceAccount,
  ServiceAccountKey,
];
const iamProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    CustomRoleProvider(),
    FederatedIdentityProviderProvider(),
    MembershipProvider(),
    ServiceAccountProvider(),
    ServiceAccountKeyProvider(),
  );

const iaasResources = [
  AffinityGroup,
  Backup,
  Image,
  ImageShare,
  KeyPair,
  Server,
  ServerNetworkInterfaceAttachment,
  ServerSecurityGroupAttachment,
  ServerServiceAccountAttachment,
  Snapshot,
  Volume,
  VolumeAttachment,
  Network,
  NetworkArea,
  NetworkAreaRegion,
  NetworkAreaRoute,
  NetworkInterface,
  PublicIp,
  RoutingTable,
  RoutingTableRoute,
  SecurityGroup,
  SecurityGroupRule,
];
const iaasProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    AffinityGroupProvider(),
    BackupProvider(),
    ImageProvider(),
    ImageShareProvider(),
    KeyPairProvider(),
    ServerProvider(),
    ServerNetworkInterfaceAttachmentProvider(),
    ServerSecurityGroupAttachmentProvider(),
    ServerServiceAccountAttachmentProvider(),
    SnapshotProvider(),
    VolumeProvider(),
    VolumeAttachmentProvider(),
    NetworkProvider(),
    NetworkAreaProvider(),
    NetworkAreaRegionProvider(),
    NetworkAreaRouteProvider(),
    NetworkInterfaceProvider(),
    PublicIpProvider(),
    RoutingTableProvider(),
    RoutingTableRouteProvider(),
    SecurityGroupProvider(),
    SecurityGroupRuleProvider(),
  );

const functionsResources = [FunctionsFunction, PullCredential];
const functionsProviders = () =>
  Layer.mergeAll(Layer.empty, FunctionProvider(), PullCredentialProvider());

const skeResources = [Cluster, Kubeconfig];
const skeProviders = () => Layer.mergeAll(Layer.empty, ClusterProvider(), KubeconfigProvider());

const containerRegistryResources = [ContainerRegistryProject, RobotAccount];
const containerRegistryProviders = () =>
  Layer.mergeAll(Layer.empty, ContainerRegistryProjectProvider(), RobotAccountProvider());

const dnsResources = [RecordSet, Zone];
const dnsProviders = () => Layer.mergeAll(Layer.empty, RecordSetProvider(), ZoneProvider());

const objectStorageResources = [
  AccessKey,
  Bucket,
  ComplianceLock,
  CredentialsGroup,
  ObjectStorageProject,
];
const objectStorageProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    AccessKeyProvider(),
    BucketProvider(),
    ComplianceLockProvider(),
    CredentialsGroupProvider(),
    ObjectStorageProjectProvider(),
  );

const loadBalancerResources = [NlbLoadBalancer, NlbObservabilityCredential];
const loadBalancerProviders = () =>
  Layer.mergeAll(Layer.empty, NlbLoadBalancerProvider(), NlbObservabilityCredentialProvider());

const postgresFlexResources = [PostgresFlexDatabase, PostgresFlexInstance, PostgresFlexUser];
const postgresFlexProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    PostgresFlexDatabaseProvider(),
    PostgresFlexInstanceProvider(),
    PostgresFlexUserProvider(),
  );

const kmsResources = [Key, KeyRing, WrappingKey];
const kmsProviders = () =>
  Layer.mergeAll(Layer.empty, KeyProvider(), KeyRingProvider(), WrappingKeyProvider());

const secretsManagerResources = [
  SecretsManagerAppRole,
  SecretsManagerAppRoleSecretId,
  SecretsManagerInstance,
  SecretsManagerSecret,
  SecretsManagerUser,
];
const secretsManagerProviders = () =>
  Layer.mergeAll(
    Layer.empty,
    SecretsManagerAppRoleProvider(),
    SecretsManagerAppRoleSecretIdProvider(),
    SecretsManagerInstanceProvider(),
    SecretsManagerSecretProvider(),
    SecretsManagerUserProvider(),
  );

const makeProviders = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      ...kmsResources,
      ...serviceEnablementResources,
      ...resourceManagerResources,
      ...iamResources,
      ...iaasResources,
      ...containerRegistryResources,
      ...functionsResources,
      ...skeResources,
      ...dnsResources,
      ...objectStorageResources,
      ...secretsManagerResources,
      ...postgresFlexResources,
      ...loadBalancerResources,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        kmsProviders(),
        serviceEnablementProviders(),
        resourceManagerProviders(),
        iamProviders(),
        iaasProviders(),
        containerRegistryProviders(),
        functionsProviders(),
        skeProviders(),
        dnsProviders(),
        objectStorageProviders(),
        secretsManagerProviders(),
        postgresFlexProviders(),
        loadBalancerProviders(),
      ),
    ),
    // The `stackit-ske` Kubernetes cluster adapter is provideMerged (not just
    // provided) so the cluster-agnostic `Kubernetes.*` workload providers can
    // resolve it from the ambient stack context.
    Layer.provideMerge(SkeKubernetesAdapter()),
    // `Stackit.Functions.Function` builds its image with Docker.
    Layer.provideMerge(DockerLive),
    Layer.provideMerge(environmentFromAuthProvider()),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(StackitAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );

let cachedProviders: ReturnType<typeof makeProviders> | undefined;

/**
 * Build a layer that registers all STACKIT resource providers, the STACKIT
 * `AuthProvider`, the resolved `Credentials` and `StackitEnvironment`, and
 * an `HttpClient`. Include it from your stack alongside other clouds'
 * `providers()` layers. Memoized: every stack and test file shares one
 * layer description.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Stackit.providers(),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     yield* Stackit.ServiceEnablement.Service("Ske", {
 *       serviceId: "cloud.stackit.ske",
 *     });
 *     return {};
 *   }),
 * );
 * ```
 */
export const providers = () => (cachedProviders ??= makeProviders());
