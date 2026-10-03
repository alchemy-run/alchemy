import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { AzureAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import * as Environment from "./Environment.ts";
import type { ServiceProviders } from "./ServiceProviders.ts";
// One import + one `services` entry per service, sorted. Each service owns
// its `<Service>/Providers.ts`; never list resources here.
import * as AdvisorProviders from "./Advisor/Providers.ts";
import * as AnalysisServicesProviders from "./AnalysisServices/Providers.ts";
import * as ApiCenterProviders from "./ApiCenter/Providers.ts";
import * as ApiManagementProviders from "./ApiManagement/Providers.ts";
import * as AppConfigurationProviders from "./AppConfiguration/Providers.ts";
import * as ApplicationInsightsProviders from "./ApplicationInsights/Providers.ts";
import * as ArcDataProviders from "./ArcData/Providers.ts";
import * as AttestationProviders from "./Attestation/Providers.ts";
import * as AuthorizationProviders from "./Authorization/Providers.ts";
import * as AutomanageProviders from "./Automanage/Providers.ts";
import * as AutomationProviders from "./Automation/Providers.ts";
import * as AzureActiveDirectoryProviders from "./AzureActiveDirectory/Providers.ts";
import * as AzureFleetProviders from "./AzureFleet/Providers.ts";
import * as AzureStackHCIProviders from "./AzureStackHCI/Providers.ts";
import * as BatchProviders from "./Batch/Providers.ts";
import * as BotServiceProviders from "./BotService/Providers.ts";
import * as CdnProviders from "./Cdn/Providers.ts";
import * as CertificateRegistrationProviders from "./CertificateRegistration/Providers.ts";
import * as ChaosProviders from "./Chaos/Providers.ts";
import * as CodeSigningProviders from "./CodeSigning/Providers.ts";
import * as CognitiveServicesProviders from "./CognitiveServices/Providers.ts";
import * as CommunicationProviders from "./Communication/Providers.ts";
import * as ComputeProviders from "./Compute/Providers.ts";
import * as ConfidentialLedgerProviders from "./ConfidentialLedger/Providers.ts";
import * as ConfluentProviders from "./Confluent/Providers.ts";
import * as ConnectedCacheProviders from "./ConnectedCache/Providers.ts";
import * as ConsumptionProviders from "./Consumption/Providers.ts";
import * as ContainerAppsProviders from "./ContainerApps/Providers.ts";
import * as ContainerInstanceProviders from "./ContainerInstance/Providers.ts";
import * as ContainerRegistryProviders from "./ContainerRegistry/Providers.ts";
import * as ContainerServiceProviders from "./ContainerService/Providers.ts";
import * as CosmosDBProviders from "./CosmosDB/Providers.ts";
import * as CosmosDBPostgreSQLProviders from "./CosmosDBPostgreSQL/Providers.ts";
import * as CostManagementProviders from "./CostManagement/Providers.ts";
import * as DataFactoryProviders from "./DataFactory/Providers.ts";
import * as DataMigrationProviders from "./DataMigration/Providers.ts";
import * as DataProtectionProviders from "./DataProtection/Providers.ts";
import * as DataShareProviders from "./DataShare/Providers.ts";
import * as DataTransferProviders from "./DataTransfer/Providers.ts";
import * as DataReplicationProviders from "./DataReplication/Providers.ts";
import * as DashboardProviders from "./Dashboard/Providers.ts";
import * as DatabaseWatcherProviders from "./DatabaseWatcher/Providers.ts";
import * as DatabricksProviders from "./Databricks/Providers.ts";
import * as DatadogProviders from "./Datadog/Providers.ts";
import * as DesktopVirtualizationProviders from "./DesktopVirtualization/Providers.ts";
import * as DevCenterProviders from "./DevCenter/Providers.ts";
import * as DevHubProviders from "./DevHub/Providers.ts";
import * as DevOpsInfrastructureProviders from "./DevOpsInfrastructure/Providers.ts";
import * as DevTestLabsProviders from "./DevTestLabs/Providers.ts";
import * as DeviceRegistryProviders from "./DeviceRegistry/Providers.ts";
import * as DeviceUpdateProviders from "./DeviceUpdate/Providers.ts";
import * as DigitalTwinsProviders from "./DigitalTwins/Providers.ts";
import * as DiscoveryProviders from "./Discovery/Providers.ts";
import * as DnsProviders from "./Dns/Providers.ts";
import * as DnsResolverProviders from "./DnsResolver/Providers.ts";
import * as DomainRegistrationProviders from "./DomainRegistration/Providers.ts";
import * as DomainServicesProviders from "./DomainServices/Providers.ts";
import * as DurableTaskProviders from "./DurableTask/Providers.ts";
import * as EdgeProviders from "./Edge/Providers.ts";
import * as ElasticProviders from "./Elastic/Providers.ts";
import * as ElasticSanProviders from "./ElasticSan/Providers.ts";
import * as EventGridProviders from "./EventGrid/Providers.ts";
import * as EventHubProviders from "./EventHub/Providers.ts";
import * as ExtendedLocationProviders from "./ExtendedLocation/Providers.ts";
import * as FabricProviders from "./Fabric/Providers.ts";
import * as FileSharesProviders from "./FileShares/Providers.ts";
import * as FirmwareAnalysisProviders from "./FirmwareAnalysis/Providers.ts";
import * as FluidRelayProviders from "./FluidRelay/Providers.ts";
import * as FrontDoorProviders from "./FrontDoor/Providers.ts";
import * as GrafanaProviders from "./Grafana/Providers.ts";
import * as GuestConfigurationProviders from "./GuestConfiguration/Providers.ts";
import * as HardwareSecurityModulesProviders from "./HardwareSecurityModules/Providers.ts";
import * as HDInsightProviders from "./HDInsight/Providers.ts";
import * as HealthBotProviders from "./HealthBot/Providers.ts";
import * as HealthcareApisProviders from "./HealthcareApis/Providers.ts";
import * as HealthDataAIServicesProviders from "./HealthDataAIServices/Providers.ts";
import * as HybridComputeProviders from "./HybridCompute/Providers.ts";
import * as HybridConnectivityProviders from "./HybridConnectivity/Providers.ts";
import * as HybridContainerServiceProviders from "./HybridContainerService/Providers.ts";
import * as HybridKubernetesProviders from "./HybridKubernetes/Providers.ts";
import * as HybridNetworkProviders from "./HybridNetwork/Providers.ts";
import * as ImageBuilderProviders from "./ImageBuilder/Providers.ts";
import * as IoTProviders from "./IoT/Providers.ts";
import * as IoTHubProviders from "./IoTHub/Providers.ts";
import * as IoTOperationsProviders from "./IoTOperations/Providers.ts";
import * as LogAnalyticsProviders from "./LogAnalytics/Providers.ts";
import * as KeyVaultProviders from "./KeyVault/Providers.ts";
import * as KustoProviders from "./Kusto/Providers.ts";
import * as KubernetesConfigurationProviders from "./KubernetesConfiguration/Providers.ts";
import * as KubernetesRuntimeProviders from "./KubernetesRuntime/Providers.ts";
import * as LighthouseProviders from "./Lighthouse/Providers.ts";
import * as LoadTestingProviders from "./LoadTesting/Providers.ts";
import * as LogicProviders from "./Logic/Providers.ts";
import * as MachineLearningProviders from "./MachineLearning/Providers.ts";
import * as MaintenanceProviders from "./Maintenance/Providers.ts";
import * as ManagedApplicationsProviders from "./ManagedApplications/Providers.ts";
import * as ManagedIdentityProviders from "./ManagedIdentity/Providers.ts";
import * as ManagedNetworkFabricProviders from "./ManagedNetworkFabric/Providers.ts";
import * as ManagementProviders from "./Management/Providers.ts";
import * as ManufacturingPlatformProviders from "./ManufacturingPlatform/Providers.ts";
import * as MapsProviders from "./Maps/Providers.ts";
import * as MigrateProviders from "./Migrate/Providers.ts";
import * as MonitorProviders from "./Monitor/Providers.ts";
import * as MySQLProviders from "./MySQL/Providers.ts";
import * as NetAppProviders from "./NetApp/Providers.ts";
import * as NetworkProviders from "./Network/Providers.ts";
import * as NetworkCloudProviders from "./NetworkCloud/Providers.ts";
import * as NetworkFunctionProviders from "./NetworkFunction/Providers.ts";
import * as NotificationHubsProviders from "./NotificationHubs/Providers.ts";
import * as PeeringProviders from "./Peering/Providers.ts";
import * as PlanetaryComputerProviders from "./PlanetaryComputer/Providers.ts";
import * as PolicyProviders from "./Policy/Providers.ts";
import * as PolicyInsightsProviders from "./PolicyInsights/Providers.ts";
import * as PortalProviders from "./Portal/Providers.ts";
import * as PostgreSQLProviders from "./PostgreSQL/Providers.ts";
import * as PowerBIProviders from "./PowerBI/Providers.ts";
import * as PrivateDnsProviders from "./PrivateDns/Providers.ts";
import * as RecoveryServicesProviders from "./RecoveryServices/Providers.ts";
import * as RedHatOpenShiftProviders from "./RedHatOpenShift/Providers.ts";
import * as RedisProviders from "./Redis/Providers.ts";
import * as RelationshipsProviders from "./Relationships/Providers.ts";
import * as RelayProviders from "./Relay/Providers.ts";
import * as ResourceConnectorProviders from "./ResourceConnector/Providers.ts";
import * as ResourceGraphProviders from "./ResourceGraph/Providers.ts";
import * as ResourceMoverProviders from "./ResourceMover/Providers.ts";
import * as ResourcesProviders from "./Resources/Providers.ts";
import * as ScVmmProviders from "./ScVmm/Providers.ts";
import * as SearchProviders from "./Search/Providers.ts";
import * as SecurityProviders from "./Security/Providers.ts";
import * as SecurityInsightsProviders from "./SecurityInsights/Providers.ts";
import * as SerialConsoleProviders from "./SerialConsole/Providers.ts";
import * as ServiceBusProviders from "./ServiceBus/Providers.ts";
import * as ServiceConnectorProviders from "./ServiceConnector/Providers.ts";
import * as ServiceFabricProviders from "./ServiceFabric/Providers.ts";
import * as ServiceFabricClassicProviders from "./ServiceFabricClassic/Providers.ts";
import * as ServiceNetworkingProviders from "./ServiceNetworking/Providers.ts";
import * as SignalRProviders from "./SignalR/Providers.ts";
import * as SiteRecoveryProviders from "./SiteRecovery/Providers.ts";
import * as SqlProviders from "./Sql/Providers.ts";
import * as SqlVirtualMachineProviders from "./SqlVirtualMachine/Providers.ts";
import * as StandbyPoolProviders from "./StandbyPool/Providers.ts";
import * as StorageProviders from "./Storage/Providers.ts";
import * as StorageActionsProviders from "./StorageActions/Providers.ts";
import * as StorageCacheProviders from "./StorageCache/Providers.ts";
import * as StorageDiscoveryProviders from "./StorageDiscovery/Providers.ts";
import * as StorageMoverProviders from "./StorageMover/Providers.ts";
import * as StorageSyncProviders from "./StorageSync/Providers.ts";
import * as StreamAnalyticsProviders from "./StreamAnalytics/Providers.ts";
import * as SynapseProviders from "./Synapse/Providers.ts";
import * as TrafficManagerProviders from "./TrafficManager/Providers.ts";
import * as VideoIndexerProviders from "./VideoIndexer/Providers.ts";
import * as VirtualEnclavesProviders from "./VirtualEnclaves/Providers.ts";
import * as VMwareProviders from "./VMware/Providers.ts";
import * as WebProviders from "./Web/Providers.ts";
import * as WebPubSubProviders from "./WebPubSub/Providers.ts";
import * as WeightsAndBiasesProviders from "./WeightsAndBiases/Providers.ts";
import * as WorkloadsProviders from "./Workloads/Providers.ts";

const services: ReadonlyArray<ServiceProviders> = [
  AdvisorProviders,
  AnalysisServicesProviders,
  ApiCenterProviders,
  ApiManagementProviders,
  AppConfigurationProviders,
  ApplicationInsightsProviders,
  ArcDataProviders,
  AttestationProviders,
  AuthorizationProviders,
  AutomanageProviders,
  AutomationProviders,
  AzureActiveDirectoryProviders,
  AzureFleetProviders,
  AzureStackHCIProviders,
  BatchProviders,
  BotServiceProviders,
  CdnProviders,
  CertificateRegistrationProviders,
  ChaosProviders,
  CodeSigningProviders,
  CognitiveServicesProviders,
  CommunicationProviders,
  ComputeProviders,
  ConfidentialLedgerProviders,
  ConfluentProviders,
  ConnectedCacheProviders,
  ConsumptionProviders,
  ContainerAppsProviders,
  ContainerInstanceProviders,
  ContainerRegistryProviders,
  ContainerServiceProviders,
  CosmosDBProviders,
  CosmosDBPostgreSQLProviders,
  CostManagementProviders,
  DataFactoryProviders,
  DataMigrationProviders,
  DataProtectionProviders,
  DataShareProviders,
  DataTransferProviders,
  DataReplicationProviders,
  DashboardProviders,
  DatabaseWatcherProviders,
  DatabricksProviders,
  DatadogProviders,
  DesktopVirtualizationProviders,
  DevCenterProviders,
  DevHubProviders,
  DevOpsInfrastructureProviders,
  DevTestLabsProviders,
  DeviceRegistryProviders,
  DeviceUpdateProviders,
  DigitalTwinsProviders,
  DiscoveryProviders,
  DnsProviders,
  DnsResolverProviders,
  DomainRegistrationProviders,
  DomainServicesProviders,
  DurableTaskProviders,
  EdgeProviders,
  ElasticProviders,
  ElasticSanProviders,
  EventGridProviders,
  EventHubProviders,
  ExtendedLocationProviders,
  FabricProviders,
  FileSharesProviders,
  FirmwareAnalysisProviders,
  FluidRelayProviders,
  FrontDoorProviders,
  GrafanaProviders,
  GuestConfigurationProviders,
  HardwareSecurityModulesProviders,
  HDInsightProviders,
  HealthBotProviders,
  HealthcareApisProviders,
  HealthDataAIServicesProviders,
  HybridComputeProviders,
  HybridConnectivityProviders,
  HybridContainerServiceProviders,
  HybridKubernetesProviders,
  HybridNetworkProviders,
  ImageBuilderProviders,
  IoTProviders,
  IoTHubProviders,
  IoTOperationsProviders,
  LogAnalyticsProviders,
  KeyVaultProviders,
  KustoProviders,
  KubernetesConfigurationProviders,
  KubernetesRuntimeProviders,
  LighthouseProviders,
  LoadTestingProviders,
  LogicProviders,
  MachineLearningProviders,
  MaintenanceProviders,
  ManagedApplicationsProviders,
  ManagedIdentityProviders,
  ManagedNetworkFabricProviders,
  ManagementProviders,
  ManufacturingPlatformProviders,
  MapsProviders,
  MigrateProviders,
  MonitorProviders,
  MySQLProviders,
  NetAppProviders,
  NetworkProviders,
  NetworkCloudProviders,
  NetworkFunctionProviders,
  NotificationHubsProviders,
  PeeringProviders,
  PlanetaryComputerProviders,
  PolicyProviders,
  PolicyInsightsProviders,
  PortalProviders,
  PostgreSQLProviders,
  PowerBIProviders,
  PrivateDnsProviders,
  RecoveryServicesProviders,
  RedHatOpenShiftProviders,
  RedisProviders,
  RelationshipsProviders,
  RelayProviders,
  ResourceConnectorProviders,
  ResourceGraphProviders,
  ResourceMoverProviders,
  ResourcesProviders,
  ScVmmProviders,
  SearchProviders,
  SecurityProviders,
  SecurityInsightsProviders,
  SerialConsoleProviders,
  ServiceBusProviders,
  ServiceConnectorProviders,
  ServiceFabricProviders,
  ServiceFabricClassicProviders,
  ServiceNetworkingProviders,
  SignalRProviders,
  SiteRecoveryProviders,
  SqlProviders,
  SqlVirtualMachineProviders,
  StandbyPoolProviders,
  StorageProviders,
  StorageActionsProviders,
  StorageCacheProviders,
  StorageDiscoveryProviders,
  StorageMoverProviders,
  StorageSyncProviders,
  StreamAnalyticsProviders,
  SynapseProviders,
  TrafficManagerProviders,
  VideoIndexerProviders,
  VirtualEnclavesProviders,
  VMwareProviders,
  WebProviders,
  WebPubSubProviders,
  WeightsAndBiasesProviders,
  WorkloadsProviders,
];

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Azure",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/** Auth, subscription environment, and HTTP client for every provider. */
const azureLive = Layer.mergeAll(
  Environment.environmentFromAuthProvider(),
  Credentials.fromAuthProvider(),
).pipe(
  Layer.provideMerge(AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

const makeProviders = () =>
  Layer.effect(
    Providers,
    Effect.gen(function* () {
      // Each service's collection is erased to its runtime shape: its
      // requirements (one Provider<X> per resource type) are satisfied by
      // the layers below, and inferring hundreds of them exhausts tsc.
      const merged: Record<string, any> = {};
      for (const service of services) {
        const collection = (yield* Provider.collection(
          service.resources as any[],
        ) as unknown as Effect.Effect<
          { providers: Record<string, any> },
          never,
          never
        >).providers;
        Object.assign(merged, collection);
      }
      return {
        kind: "ProviderCollection" as const,
        get: (type: string) => merged[type],
        providers: merged,
      };
    }),
  ).pipe(
    Layer.provide(
      (
        Layer.mergeAll as (
          ...layers: Layer.Layer<any, any, any>[]
        ) => Layer.Layer<any, any, any>
      )(...services.map((service) => service.layers())).pipe(
        Layer.provide(azureLive),
      ),
    ),
    Layer.provideMerge(azureLive),
    Layer.orDie,
    // Erased on purpose: the inferred union of hundreds of provider layers
    // exhausts the type-checker.
  ) as Layer.Layer<any, never, never>;

let cachedProviders: ReturnType<typeof makeProviders> | undefined;

/**
 * Build a layer that registers all Azure resource providers, the Azure
 * `AuthProvider`, the resolved distilled `Credentials`, the
 * `AzureEnvironment` (subscription, tenant, default location), and an
 * `HttpClient`. Include it from your stack alongside other cloud
 * `providers()` layers.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Azure from "alchemy/Azure";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Azure.providers().pipe(
 *       Layer.provideMerge(Azure.location("westeurope")),
 *     ),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const group = yield* Azure.Resources.ResourceGroup("app");
 *     return { group: group.resourceGroupName };
 *   }),
 * );
 * ```
 */
export const providers = () => (cachedProviders ??= makeProviders());
