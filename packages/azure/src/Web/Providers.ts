import * as Layer from "effect/Layer";
import { AiGateway, AiGatewayProvider } from "./AiGateway.ts";
import { AppServiceEnvironment, AppServiceEnvironmentProvider } from "./AppServiceEnvironment.ts";
import { AppServicePlan, AppServicePlanProvider } from "./AppServicePlan.ts";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import {
  DomainOwnershipIdentifier,
  DomainOwnershipIdentifierProvider,
} from "./DomainOwnershipIdentifier.ts";
import { FunctionApp, FunctionAppProvider } from "./FunctionApp.ts";
import { FunctionAppHostKey, FunctionAppHostKeyProvider } from "./FunctionAppHostKey.ts";
import { FunctionKey, FunctionKeyProvider } from "./FunctionKey.ts";
import {
  GatewayVirtualNetworkIntegration,
  GatewayVirtualNetworkIntegrationProvider,
} from "./GatewayVirtualNetworkIntegration.ts";
import { HostNameBinding, HostNameBindingProvider } from "./HostNameBinding.ts";
import { HybridConnection, HybridConnectionProvider } from "./HybridConnection.ts";
import { PremierAddOn, PremierAddOnProvider } from "./PremierAddOn.ts";
import { PrivateAccess, PrivateAccessProvider } from "./PrivateAccess.ts";
import { PublicCertificate, PublicCertificateProvider } from "./PublicCertificate.ts";
import {
  PublishingCredentialsPolicy,
  PublishingCredentialsPolicyProvider,
} from "./PublishingCredentialsPolicy.ts";
import { SiteCertificate, SiteCertificateProvider } from "./SiteCertificate.ts";
import { SiteContainer, SiteContainerProvider } from "./SiteContainer.ts";
import { SiteExtension, SiteExtensionProvider } from "./SiteExtension.ts";
import { SiteFunction, SiteFunctionProvider } from "./SiteFunction.ts";
import { SourceControl, SourceControlProvider } from "./SourceControl.ts";
import { StaticSite, StaticSiteProvider } from "./StaticSite.ts";
import { StaticSiteBasicAuth, StaticSiteBasicAuthProvider } from "./StaticSiteBasicAuth.ts";
import {
  StaticSiteCustomDomain,
  StaticSiteCustomDomainProvider,
} from "./StaticSiteCustomDomain.ts";
import {
  StaticSiteDatabaseConnection,
  StaticSiteDatabaseConnectionProvider,
} from "./StaticSiteDatabaseConnection.ts";
import {
  StaticSiteEnvironmentSettings,
  StaticSiteEnvironmentSettingsProvider,
} from "./StaticSiteEnvironmentSettings.ts";
import {
  StaticSiteLinkedBackend,
  StaticSiteLinkedBackendProvider,
} from "./StaticSiteLinkedBackend.ts";
import {
  StaticSiteUserProvidedFunctionApp,
  StaticSiteUserProvidedFunctionAppProvider,
} from "./StaticSiteUserProvidedFunctionApp.ts";
import {
  VirtualNetworkIntegration,
  VirtualNetworkIntegrationProvider,
} from "./VirtualNetworkIntegration.ts";
import { VirtualNetworkRoute, VirtualNetworkRouteProvider } from "./VirtualNetworkRoute.ts";
import { WebApp, WebAppProvider } from "./WebApp.ts";
import { WebAppAuthSettings, WebAppAuthSettingsProvider } from "./WebAppAuthSettings.ts";
import {
  WebAppBackupConfiguration,
  WebAppBackupConfigurationProvider,
} from "./WebAppBackupConfiguration.ts";
import { WebAppSlot, WebAppSlotProvider } from "./WebAppSlot.ts";

export const resources = [
  AiGateway,
  AppServiceEnvironment,
  AppServicePlan,
  Certificate,
  DomainOwnershipIdentifier,
  FunctionApp,
  FunctionAppHostKey,
  FunctionKey,
  GatewayVirtualNetworkIntegration,
  HostNameBinding,
  HybridConnection,
  PremierAddOn,
  PrivateAccess,
  PublicCertificate,
  PublishingCredentialsPolicy,
  SiteCertificate,
  SiteContainer,
  SiteExtension,
  SiteFunction,
  SourceControl,
  StaticSite,
  StaticSiteBasicAuth,
  StaticSiteCustomDomain,
  StaticSiteDatabaseConnection,
  StaticSiteEnvironmentSettings,
  StaticSiteLinkedBackend,
  StaticSiteUserProvidedFunctionApp,
  VirtualNetworkIntegration,
  VirtualNetworkRoute,
  WebApp,
  WebAppAuthSettings,
  WebAppBackupConfiguration,
  WebAppSlot,
];
export const layers = () =>
  Layer.mergeAll(
    AiGatewayProvider(),
    AppServiceEnvironmentProvider(),
    AppServicePlanProvider(),
    CertificateProvider(),
    DomainOwnershipIdentifierProvider(),
    FunctionAppProvider(),
    FunctionAppHostKeyProvider(),
    FunctionKeyProvider(),
    GatewayVirtualNetworkIntegrationProvider(),
    HostNameBindingProvider(),
    HybridConnectionProvider(),
    PremierAddOnProvider(),
    PrivateAccessProvider(),
    PublicCertificateProvider(),
    PublishingCredentialsPolicyProvider(),
    SiteCertificateProvider(),
    SiteContainerProvider(),
    SiteExtensionProvider(),
    SiteFunctionProvider(),
    SourceControlProvider(),
    StaticSiteProvider(),
    StaticSiteBasicAuthProvider(),
    StaticSiteCustomDomainProvider(),
    StaticSiteDatabaseConnectionProvider(),
    StaticSiteEnvironmentSettingsProvider(),
    StaticSiteLinkedBackendProvider(),
    StaticSiteUserProvidedFunctionAppProvider(),
    VirtualNetworkIntegrationProvider(),
    VirtualNetworkRouteProvider(),
    WebAppProvider(),
    WebAppAuthSettingsProvider(),
    WebAppBackupConfigurationProvider(),
    WebAppSlotProvider(),
  );
