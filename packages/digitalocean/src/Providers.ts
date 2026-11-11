import { layerS3Keys } from "@distilled.cloud/digitalocean/Spaces";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Command from "alchemy/Command";
import { KeyPair, KeyPairProvider } from "alchemy/KeyPair";
import * as Provider from "alchemy/Provider";
import {
  Server as WebsiteServer,
  ServerProvider as WebsiteServerProvider,
} from "alchemy/Website/Server";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as ActionGateway from "./ActionGateway/index.ts";
import * as Agents from "./Agents/index.ts";
import { App, AppProvider } from "./App.ts";
import { DigitalOceanAuth } from "./AuthProvider.ts";
import { AutoscalePool, AutoscalePoolProvider } from "./AutoscalePool.ts";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import * as Credentials from "./Credentials.ts";
import * as Databases from "./Databases/index.ts";
import { Domain, DomainProvider } from "./Domain.ts";
import { DomainRecord, DomainRecordProvider } from "./DomainRecord.ts";
import { Droplet, DropletProvider } from "./Droplet.ts";
import { DropletSnapshot, DropletSnapshotProvider } from "./DropletSnapshot.ts";
import { Firewall, FirewallProvider } from "./Firewall.ts";
import * as Functions from "./Functions/index.ts";
import * as GenAI from "./GenAI/index.ts";
import { Image, ImageProvider } from "./Image.ts";
import * as Inference from "./Inference/index.ts";
import * as Insights from "./Insights/index.ts";
import * as Kubernetes from "./Kubernetes/index.ts";
import { LoadBalancer, LoadBalancerProvider } from "./LoadBalancer.ts";
import * as Monitoring from "./Monitoring/index.ts";
import { NatGateway, NatGatewayProvider } from "./NatGateway.ts";
import { Nfs, NfsProvider } from "./Nfs.ts";
import { Project, ProjectProvider } from "./Project.ts";
import { ProjectResources, ProjectResourcesProvider } from "./ProjectResources.ts";
import { Registry, RegistryProvider } from "./Registry.ts";
import { ReservedIp, ReservedIpProvider } from "./ReservedIp.ts";
import { ReservedIpAssignment, ReservedIpAssignmentProvider } from "./ReservedIpAssignment.ts";
import { ReservedIpv6, ReservedIpv6Provider } from "./ReservedIpv6.ts";
import {
  ReservedIpv6Assignment,
  ReservedIpv6AssignmentProvider,
} from "./ReservedIpv6Assignment.ts";
import * as Sandboxes from "./Sandboxes/index.ts";
import * as Security from "./Security/index.ts";
import * as Spaces from "./Spaces/index.ts";
import { SshKey, SshKeyProvider } from "./SshKey.ts";
import { Tag, TagProvider } from "./Tag.ts";
import * as VectorDB from "./VectorDB/index.ts";
import { Volume, VolumeProvider } from "./Volume.ts";
import { VolumeAttachment, VolumeAttachmentProvider } from "./VolumeAttachment.ts";
import { VolumeSnapshot, VolumeSnapshotProvider } from "./VolumeSnapshot.ts";
import { Vpc, VpcProvider } from "./Vpc.ts";
import { VpcPeering, VpcPeeringProvider } from "./VpcPeering.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("DigitalOcean") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build a layer that registers all DigitalOcean resource providers, the
 * DigitalOcean `AuthProvider`, the resolved `Credentials`, and an
 * `HttpClient`. Include this from your stack alongside other cloud
 * `providers()` layers.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as DigitalOcean from "@alchemy.run/digitalocean";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: DigitalOcean.providers(),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const host = yield* DigitalOcean.Droplet("app", {
 *       region: "sfo3",
 *       size: "s-2vcpu-4gb",
 *       image: "ubuntu-24-04-x64",
 *     });
 *     return { ip: host.ipv4 };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Droplet,
      Firewall,
      SshKey,
      Volume,
      VolumeAttachment,
      Vpc,
      ReservedIp,
      ReservedIpAssignment,
      Domain,
      DomainRecord,
      Project,
      ProjectResources,
      Tag,
      LoadBalancer,
      Certificate,
      Spaces.Bucket,
      Spaces.CdnEndpoint,
      Spaces.Key,
      Monitoring.AlertPolicy,
      Monitoring.UptimeAlert,
      Monitoring.UptimeCheck,
      ReservedIpv6,
      ReservedIpv6Assignment,
      VpcPeering,
      Registry,
      Image,
      Databases.Cluster,
      Databases.ConnectionPool,
      Databases.Database,
      Databases.Firewall,
      Databases.Replica,
      Databases.User,
      Kubernetes.Cluster,
      Kubernetes.NodePool,
      App,
      Sandboxes.Template,
      Sandboxes.Sandbox,
      NatGateway,
      Nfs,
      AutoscalePool,
      KeyPair,
      GenAI.Agent,
      GenAI.AgentApiKey,
      GenAI.KnowledgeBase,
      GenAI.Workspace,
      GenAI.ModelRouter,
      GenAI.ProviderKey,
      Security.Secret,
      Functions.Namespace,
      Functions.AccessKey,
      Functions.Action,
      Functions.Trigger,
      Insights.NotificationChannel,
      Insights.AlertRule,
      Insights.Dashboard,
      VectorDB.Database,
      DropletSnapshot,
      VolumeSnapshot,
      Agents.EnvironmentConfig,
      Agents.Trigger,
      Agents.Template,
      ActionGateway.Toolbelt,
      ActionGateway.McpServer,
      Monitoring.Destination,
      Monitoring.Sink,
      Inference.DedicatedInference,
      WebsiteServer,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        DropletProvider(),
        FirewallProvider(),
        SshKeyProvider(),
        VolumeProvider(),
        VolumeAttachmentProvider(),
        VpcProvider(),
        ReservedIpProvider(),
        ReservedIpAssignmentProvider(),
        DomainProvider(),
        DomainRecordProvider(),
        ProjectProvider(),
        ProjectResourcesProvider(),
        TagProvider(),
        LoadBalancerProvider(),
        CertificateProvider(),
        Spaces.BucketProvider(),
        Spaces.CdnEndpointProvider(),
        Spaces.KeyProvider(),
        Monitoring.AlertPolicyProvider(),
        Monitoring.UptimeAlertProvider(),
        Monitoring.UptimeCheckProvider(),
        Databases.ClusterProvider(),
        Databases.ConnectionPoolProvider(),
        Databases.DatabaseProvider(),
        Databases.FirewallProvider(),
        Databases.ReplicaProvider(),
        Databases.UserProvider(),
        ReservedIpv6Provider(),
        ReservedIpv6AssignmentProvider(),
        VpcPeeringProvider(),
        RegistryProvider(),
        ImageProvider(),
        Kubernetes.ClusterProvider(),
        Kubernetes.NodePoolProvider(),
        AppProvider(),
        Sandboxes.TemplateProvider(),
        Sandboxes.SandboxProvider(),
        NatGatewayProvider(),
        NfsProvider(),
        AutoscalePoolProvider(),
        DropletSnapshotProvider(),
        VolumeSnapshotProvider(),
        KeyPairProvider(),
        GenAI.AgentProvider(),
        GenAI.AgentApiKeyProvider(),
        GenAI.KnowledgeBaseProvider(),
        GenAI.WorkspaceProvider(),
        GenAI.ModelRouterProvider(),
        GenAI.ProviderKeyProvider(),
        Security.SecretProvider(),
        Functions.NamespaceProvider(),
        Functions.AccessKeyProvider(),
        Functions.ActionProvider(),
        Functions.TriggerProvider(),
        Insights.NotificationChannelProvider(),
        Insights.AlertRuleProvider(),
        Insights.DashboardProvider(),
        VectorDB.DatabaseProvider(),
        Agents.EnvironmentConfigProvider(),
        Agents.TriggerProvider(),
        Agents.TemplateProvider(),
        ActionGateway.ToolbeltProvider(),
        ActionGateway.McpServerProvider(),
        Monitoring.DestinationProvider(),
        Monitoring.SinkProvider(),
        Inference.DedicatedInferenceProvider(),
        WebsiteServerProvider(),
      ),
    ),
    // Spaces' S3 API signs with Spaces keys, not the token.
    // `Kubernetes.*` workloads on a DigitalOcean cluster resolve this adapter.
    Layer.provideMerge(Command.providers()),
    Layer.provideMerge(Kubernetes.DoksKubernetesAdapter()),
    Layer.provideMerge(layerS3Keys()),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(DigitalOceanAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
