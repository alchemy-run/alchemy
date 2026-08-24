import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import { DockerLive } from "../Docker/Docker.ts";
import * as Provider from "../Provider.ts";
import { GcpAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { ListDockerImagesHttp } from "./ArtifactRegistry/ListDockerImagesHttp.ts";
import {
  Repository,
  RepositoryProvider,
} from "./ArtifactRegistry/Repository.ts";
import {
  Certificate,
  CertificateProvider,
} from "./CertificateManager/Certificate.ts";
import { Dataset, DatasetProvider } from "./BigQuery/Dataset.ts";
import { InsertAllHttp } from "./BigQuery/InsertAllHttp.ts";
import { ListTabledataHttp } from "./BigQuery/ListTabledataHttp.ts";
import { QueryHttp } from "./BigQuery/QueryHttp.ts";
import { Table, TableProvider } from "./BigQuery/Table.ts";
import { Trigger, TriggerProvider } from "./Eventarc/Trigger.ts";
import {
  Function as CloudFunction,
  FunctionProvider,
} from "./CloudFunctions/Function.ts";
import { GenerateDownloadUrlHttp } from "./CloudFunctions/GenerateDownloadUrlHttp.ts";
import { GetFunctionHttp } from "./CloudFunctions/GetFunctionHttp.ts";
import { Job, JobProvider } from "./CloudScheduler/Job.ts";
import { PauseJobHttp } from "./CloudScheduler/PauseJobHttp.ts";
import { ResumeJobHttp } from "./CloudScheduler/ResumeJobHttp.ts";
import { RunJobHttp } from "./CloudScheduler/RunJobHttp.ts";
import { CreateTaskHttp } from "./CloudTasks/CreateTaskHttp.ts";
import {
  Job as CloudRunJob,
  JobProvider as CloudRunJobProvider,
} from "./Run/Job.ts";
import { RunJobHttp as CloudRunRunJobHttp } from "./Run/RunJobHttp.ts";
import { GetServiceHttp } from "./Run/GetServiceHttp.ts";
import { Service, ServiceProvider } from "./Run/Service.ts";
import { Queue, QueueProvider } from "./CloudTasks/Queue.ts";
import { Cluster, ClusterProvider } from "./Container/Cluster.ts";
import { GetClusterHttp } from "./Container/GetClusterHttp.ts";
import { GkeKubernetesAdapter } from "./Container/KubernetesAdapter.ts";
import { GetNodePoolHttp } from "./Container/GetNodePoolHttp.ts";
import { NodePool, NodePoolProvider } from "./Container/NodePool.ts";
import { Address, AddressProvider } from "./Compute/Address.ts";
import { Disk, DiskProvider } from "./Compute/Disk.ts";
import { Snapshot, SnapshotProvider } from "./Compute/Snapshot.ts";
import {
  GlobalAddress,
  GlobalAddressProvider,
} from "./Compute/GlobalAddress.ts";
import {
  BackendBucket,
  BackendBucketProvider,
} from "./Compute/BackendBucket.ts";
import {
  BackendService,
  BackendServiceProvider,
} from "./Compute/BackendService.ts";
import { HealthCheck, HealthCheckProvider } from "./Compute/HealthCheck.ts";
import { Image, ImageProvider } from "./Compute/Image.ts";
import { Instance, InstanceProvider } from "./Compute/Instance.ts";
import { GetInstanceHttp } from "./Compute/GetInstanceHttp.ts";
import { StartInstanceHttp } from "./Compute/StartInstanceHttp.ts";
import { StopInstanceHttp } from "./Compute/StopInstanceHttp.ts";
import {
  InstanceGroup,
  InstanceGroupProvider,
} from "./Compute/InstanceGroup.ts";
import {
  InstanceTemplate,
  InstanceTemplateProvider,
} from "./Compute/InstanceTemplate.ts";
import { Network, NetworkProvider } from "./Compute/Network.ts";
import { Subnetwork, SubnetworkProvider } from "./Compute/Subnetwork.ts";
import { Firewall, FirewallProvider } from "./Compute/Firewall.ts";
import {
  ForwardingRule,
  ForwardingRuleProvider,
} from "./Compute/ForwardingRule.ts";
import { Route, RouteProvider } from "./Compute/Route.ts";
import {
  ResourcePolicy,
  ResourcePolicyProvider,
} from "./Compute/ResourcePolicy.ts";
import { Router, RouterProvider } from "./Compute/Router.ts";
import { UrlMap, UrlMapProvider } from "./Compute/UrlMap.ts";
import {
  TargetHttpProxy,
  TargetHttpProxyProvider,
} from "./Compute/TargetHttpProxy.ts";
import {
  TargetHttpsProxy,
  TargetHttpsProxyProvider,
} from "./Compute/TargetHttpsProxy.ts";
import {
  GlobalForwardingRule,
  GlobalForwardingRuleProvider,
} from "./Compute/GlobalForwardingRule.ts";
import {
  SslCertificate,
  SslCertificateProvider,
} from "./Compute/SslCertificate.ts";
import { VpnGateway, VpnGatewayProvider } from "./Compute/VpnGateway.ts";
import { ManagedZone, ManagedZoneProvider } from "./DNS/ManagedZone.ts";
import {
  ResourceRecordSet,
  ResourceRecordSetProvider,
} from "./DNS/ResourceRecordSet.ts";
import { Database, DatabaseProvider } from "./Firestore/Database.ts";
import { DeleteDocumentHttp } from "./Firestore/DeleteDocumentHttp.ts";
import { GetDocumentHttp } from "./Firestore/GetDocumentHttp.ts";
import { PatchDocumentHttp } from "./Firestore/PatchDocumentHttp.ts";
import { fromCredentials } from "./Environment.ts";
import { AcknowledgeHttp } from "./PubSub/AcknowledgeHttp.ts";
import { GetSchemaHttp } from "./PubSub/GetSchemaHttp.ts";
import { PublishHttp } from "./PubSub/PublishHttp.ts";
import { PullHttp } from "./PubSub/PullHttp.ts";
import { Schema, SchemaProvider } from "./PubSub/Schema.ts";
import { Subscription, SubscriptionProvider } from "./PubSub/Subscription.ts";
import { Topic, TopicProvider } from "./PubSub/Topic.ts";
import { ValidateMessageHttp } from "./PubSub/ValidateMessageHttp.ts";
import { CryptoKey, CryptoKeyProvider } from "./KMS/CryptoKey.ts";
import { DecryptHttp } from "./KMS/DecryptHttp.ts";
import { EncryptHttp } from "./KMS/EncryptHttp.ts";
import { KeyRing, KeyRingProvider } from "./KMS/KeyRing.ts";
import { Metric, MetricProvider } from "./Logging/Metric.ts";
import { Sink, SinkProvider } from "./Logging/Sink.ts";
import { AccessSecretVersionHttp } from "./SecretManager/AccessSecretVersionHttp.ts";
import { AddSecretVersionHttp } from "./SecretManager/AddSecretVersionHttp.ts";
import { Secret, SecretProvider } from "./SecretManager/Secret.ts";
import { Bucket, BucketProvider } from "./Storage/Bucket.ts";
import { Notification, NotificationProvider } from "./Storage/Notification.ts";
import { DeleteObjectHttp } from "./Storage/DeleteObjectHttp.ts";
import { GetObjectHttp } from "./Storage/GetObjectHttp.ts";
import { PutObjectHttp } from "./Storage/PutObjectHttp.ts";
import { GetAuthStringHttp } from "./Redis/GetAuthStringHttp.ts";
import { GetInstanceHttp as GetRedisInstanceHttp } from "./Redis/GetInstanceHttp.ts";
import {
  Instance as RedisInstance,
  InstanceProvider as RedisInstanceProvider,
} from "./Redis/Instance.ts";
import { ExecuteSqlHttp } from "./SQL/ExecuteSqlHttp.ts";
import { GetInstanceHttp as GetSqlInstanceHttp } from "./SQL/GetInstanceHttp.ts";
import {
  Database as SqlDatabase,
  DatabaseProvider as SqlDatabaseProvider,
} from "./SQL/Database.ts";
import {
  Instance as SqlInstance,
  InstanceProvider as SqlInstanceProvider,
} from "./SQL/Instance.ts";
import { Connector, ConnectorProvider } from "./VpcAccess/Connector.ts";
import { CreateExecutionHttp } from "./Workflows/CreateExecutionHttp.ts";
import { Workflow, WorkflowProvider } from "./Workflows/Workflow.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "GCP",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build a layer that registers all GCP resource providers, the GCP
 * `AuthProvider`, the resolved `Credentials`, and an `HttpClient`. Include
 * this from your stack alongside other cloud `providers()` layers.
 *
 * Resource providers are inserted into {@link Provider.collection} as they
 * land.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as GCP from "alchemy/GCP";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: GCP.providers(),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     return {};
 *   }),
 * );
 * ```
 */
const gcpCredentials = Credentials.fromAuthProvider();

/** Auth + env + HTTP client for resource providers, HTTP bindings, and GKE. */
const gcpLive = Layer.mergeAll(
  gcpCredentials,
  fromCredentials().pipe(Layer.provide(gcpCredentials)),
  GcpAuth,
  ProfileLive,
  CredentialsStoreLive,
  FetchHttpClient.layer,
);

export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Bucket,
      Notification,
      Topic,
      Subscription,
      Schema,
      KeyRing,
      CryptoKey,
      Sink,
      Metric,
      Secret,
      Certificate,
      Dataset,
      Table,
      CloudFunction,
      Database,
      RedisInstance,
      Cluster,
      NodePool,
      SqlInstance,
      SqlDatabase,
      Repository,
      Queue,
      Job,
      CloudRunJob,
      Service,
      ManagedZone,
      ResourceRecordSet,
      Address,
      BackendBucket,
      BackendService,
      HealthCheck,
      Image,
      Instance,
      InstanceGroup,
      InstanceTemplate,
      Disk,
      Snapshot,
      Network,
      Subnetwork,
      GlobalAddress,
      Route,
      ResourcePolicy,
      Router,
      Firewall,
      ForwardingRule,
      UrlMap,
      TargetHttpProxy,
      TargetHttpsProxy,
      GlobalForwardingRule,
      SslCertificate,
      VpnGateway,
      Connector,
      Workflow,
      Trigger,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mergeAll(
          BucketProvider(),
          NotificationProvider(),
          TopicProvider(),
          SubscriptionProvider(),
          SchemaProvider(),
          KeyRingProvider(),
          CryptoKeyProvider(),
          SinkProvider(),
          MetricProvider(),
          SecretProvider(),
          CertificateProvider(),
          DatasetProvider(),
          TableProvider(),
          FunctionProvider(),
        ),
        Layer.mergeAll(
          DatabaseProvider(),
          RedisInstanceProvider(),
          ClusterProvider(),
          NodePoolProvider(),
          SqlInstanceProvider(),
          SqlDatabaseProvider(),
          RepositoryProvider(),
          QueueProvider(),
          JobProvider(),
          CloudRunJobProvider(),
          ServiceProvider(),
          ManagedZoneProvider(),
          ResourceRecordSetProvider(),
        ),
        Layer.mergeAll(
          AddressProvider(),
          BackendBucketProvider(),
          BackendServiceProvider(),
          HealthCheckProvider(),
          ImageProvider(),
          InstanceProvider(),
          InstanceGroupProvider(),
          InstanceTemplateProvider(),
          NetworkProvider(),
          SubnetworkProvider(),
          DiskProvider(),
          SnapshotProvider(),
          GlobalAddressProvider(),
        ),
        Layer.mergeAll(
          RouteProvider(),
          ResourcePolicyProvider(),
          RouterProvider(),
          FirewallProvider(),
          ForwardingRuleProvider(),
          UrlMapProvider(),
          TargetHttpProxyProvider(),
          TargetHttpsProxyProvider(),
          GlobalForwardingRuleProvider(),
          SslCertificateProvider(),
          VpnGatewayProvider(),
          ConnectorProvider(),
          WorkflowProvider(),
          TriggerProvider(),
        ),
      ).pipe(Layer.provide(gcpLive)),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mergeAll(
          GetObjectHttp,
          PutObjectHttp,
          DeleteObjectHttp,
          PublishHttp,
          PullHttp,
          AcknowledgeHttp,
          GetSchemaHttp,
          ValidateMessageHttp,
          EncryptHttp,
          DecryptHttp,
          AccessSecretVersionHttp,
          AddSecretVersionHttp,
          QueryHttp,
          InsertAllHttp,
          ListTabledataHttp,
        ),
        Layer.mergeAll(
          GetFunctionHttp,
          GenerateDownloadUrlHttp,
          GetDocumentHttp,
          PatchDocumentHttp,
          DeleteDocumentHttp,
          ListDockerImagesHttp,
          CreateTaskHttp,
          PauseJobHttp,
          ResumeJobHttp,
          RunJobHttp,
          CloudRunRunJobHttp,
          GetServiceHttp,
          GetInstanceHttp,
          GetRedisInstanceHttp,
          GetClusterHttp,
        ),
        Layer.mergeAll(
          GetNodePoolHttp,
          GetSqlInstanceHttp,
          ExecuteSqlHttp,
          GetAuthStringHttp,
          StartInstanceHttp,
          StopInstanceHttp,
          CreateExecutionHttp,
        ),
      ).pipe(Layer.provide(gcpLive)),
    ),
    // The `gcp-gke` Kubernetes cluster adapter is provideMerged (not just
    // provided) so the cluster-agnostic `Kubernetes.*` workload providers
    // can resolve it from the ambient stack context.
    Layer.provideMerge(
      GkeKubernetesAdapter().pipe(
        Layer.provide(gcpLive),
        Layer.provide(DockerLive),
      ),
    ),
    Layer.provideMerge(gcpLive),
    Layer.provideMerge(DockerLive),
    Layer.orDie,
  );
