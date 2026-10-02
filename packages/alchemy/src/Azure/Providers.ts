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
import * as ApiManagementProviders from "./ApiManagement/Providers.ts";
import * as AppConfigurationProviders from "./AppConfiguration/Providers.ts";
import * as AuthorizationProviders from "./Authorization/Providers.ts";
import * as AutomationProviders from "./Automation/Providers.ts";
import * as AzureStackHCIProviders from "./AzureStackHCI/Providers.ts";
import * as CdnProviders from "./Cdn/Providers.ts";
import * as CognitiveServicesProviders from "./CognitiveServices/Providers.ts";
import * as ComputeProviders from "./Compute/Providers.ts";
import * as ContainerAppsProviders from "./ContainerApps/Providers.ts";
import * as ContainerInstanceProviders from "./ContainerInstance/Providers.ts";
import * as ContainerRegistryProviders from "./ContainerRegistry/Providers.ts";
import * as ContainerServiceProviders from "./ContainerService/Providers.ts";
import * as CosmosDBProviders from "./CosmosDB/Providers.ts";
import * as DataFactoryProviders from "./DataFactory/Providers.ts";
import * as DataShareProviders from "./DataShare/Providers.ts";
import * as DataReplicationProviders from "./DataReplication/Providers.ts";
import * as DesktopVirtualizationProviders from "./DesktopVirtualization/Providers.ts";
import * as DevCenterProviders from "./DevCenter/Providers.ts";
import * as DevTestLabsProviders from "./DevTestLabs/Providers.ts";
import * as DeviceRegistryProviders from "./DeviceRegistry/Providers.ts";
import * as DiscoveryProviders from "./Discovery/Providers.ts";
import * as DnsResolverProviders from "./DnsResolver/Providers.ts";
import * as EdgeProviders from "./Edge/Providers.ts";
import * as EventGridProviders from "./EventGrid/Providers.ts";
import * as EventHubProviders from "./EventHub/Providers.ts";
import * as HybridNetworkProviders from "./HybridNetwork/Providers.ts";
import * as IoTOperationsProviders from "./IoTOperations/Providers.ts";
import * as LogAnalyticsProviders from "./LogAnalytics/Providers.ts";
import * as KeyVaultProviders from "./KeyVault/Providers.ts";
import * as KustoProviders from "./Kusto/Providers.ts";
import * as LogicProviders from "./Logic/Providers.ts";
import * as MachineLearningProviders from "./MachineLearning/Providers.ts";
import * as ManagedIdentityProviders from "./ManagedIdentity/Providers.ts";
import * as ManagedNetworkFabricProviders from "./ManagedNetworkFabric/Providers.ts";
import * as MigrateProviders from "./Migrate/Providers.ts";
import * as MonitorProviders from "./Monitor/Providers.ts";
import * as MySQLProviders from "./MySQL/Providers.ts";
import * as NetAppProviders from "./NetApp/Providers.ts";
import * as NetworkProviders from "./Network/Providers.ts";
import * as NetworkCloudProviders from "./NetworkCloud/Providers.ts";
import * as PolicyProviders from "./Policy/Providers.ts";
import * as PostgreSQLProviders from "./PostgreSQL/Providers.ts";
import * as PrivateDnsProviders from "./PrivateDns/Providers.ts";
import * as RecoveryServicesProviders from "./RecoveryServices/Providers.ts";
import * as RedisProviders from "./Redis/Providers.ts";
import * as RelayProviders from "./Relay/Providers.ts";
import * as ResourcesProviders from "./Resources/Providers.ts";
import * as SearchProviders from "./Search/Providers.ts";
import * as SecurityInsightsProviders from "./SecurityInsights/Providers.ts";
import * as ServiceBusProviders from "./ServiceBus/Providers.ts";
import * as SiteRecoveryProviders from "./SiteRecovery/Providers.ts";
import * as SqlProviders from "./Sql/Providers.ts";
import * as StorageProviders from "./Storage/Providers.ts";
import * as SynapseProviders from "./Synapse/Providers.ts";
import * as VMwareProviders from "./VMware/Providers.ts";
import * as WebProviders from "./Web/Providers.ts";

const services: ReadonlyArray<ServiceProviders> = [
  ApiManagementProviders,
  AppConfigurationProviders,
  AuthorizationProviders,
  AutomationProviders,
  AzureStackHCIProviders,
  CdnProviders,
  CognitiveServicesProviders,
  ComputeProviders,
  ContainerAppsProviders,
  ContainerInstanceProviders,
  ContainerRegistryProviders,
  ContainerServiceProviders,
  CosmosDBProviders,
  DataFactoryProviders,
  DataShareProviders,
  DataReplicationProviders,
  DesktopVirtualizationProviders,
  DevCenterProviders,
  DevTestLabsProviders,
  DeviceRegistryProviders,
  DiscoveryProviders,
  DnsResolverProviders,
  EdgeProviders,
  EventGridProviders,
  EventHubProviders,
  HybridNetworkProviders,
  IoTOperationsProviders,
  LogAnalyticsProviders,
  KeyVaultProviders,
  KustoProviders,
  LogicProviders,
  MachineLearningProviders,
  ManagedIdentityProviders,
  ManagedNetworkFabricProviders,
  MigrateProviders,
  MonitorProviders,
  MySQLProviders,
  NetAppProviders,
  NetworkProviders,
  NetworkCloudProviders,
  PolicyProviders,
  PostgreSQLProviders,
  PrivateDnsProviders,
  RecoveryServicesProviders,
  RedisProviders,
  RelayProviders,
  ResourcesProviders,
  SearchProviders,
  SecurityInsightsProviders,
  ServiceBusProviders,
  SiteRecoveryProviders,
  SqlProviders,
  StorageProviders,
  SynapseProviders,
  VMwareProviders,
  WebProviders,
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
