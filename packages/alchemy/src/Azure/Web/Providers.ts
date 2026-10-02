import * as Layer from "effect/Layer";
import { AiGateway, AiGatewayProvider } from "./AiGateway.ts";
import {
  AppServiceEnvironment,
  AppServiceEnvironmentProvider,
} from "./AppServiceEnvironment.ts";
import { AppServicePlan, AppServicePlanProvider } from "./AppServicePlan.ts";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import {
  DomainOwnershipIdentifier,
  DomainOwnershipIdentifierProvider,
} from "./DomainOwnershipIdentifier.ts";
import { FunctionApp, FunctionAppProvider } from "./FunctionApp.ts";
import {
  FunctionAppHostKey,
  FunctionAppHostKeyProvider,
} from "./FunctionAppHostKey.ts";
import { FunctionKey, FunctionKeyProvider } from "./FunctionKey.ts";
import { HostNameBinding, HostNameBindingProvider } from "./HostNameBinding.ts";
import {
  HybridConnection,
  HybridConnectionProvider,
} from "./HybridConnection.ts";
import {
  PublicCertificate,
  PublicCertificateProvider,
} from "./PublicCertificate.ts";
import { SiteCertificate, SiteCertificateProvider } from "./SiteCertificate.ts";
import { SiteContainer, SiteContainerProvider } from "./SiteContainer.ts";
import { SiteExtension, SiteExtensionProvider } from "./SiteExtension.ts";
import { SourceControl, SourceControlProvider } from "./SourceControl.ts";
import { StaticSite, StaticSiteProvider } from "./StaticSite.ts";
import {
  StaticSiteBasicAuth,
  StaticSiteBasicAuthProvider,
} from "./StaticSiteBasicAuth.ts";
import {
  StaticSiteCustomDomain,
  StaticSiteCustomDomainProvider,
} from "./StaticSiteCustomDomain.ts";
import {
  StaticSiteDatabaseConnection,
  StaticSiteDatabaseConnectionProvider,
} from "./StaticSiteDatabaseConnection.ts";
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
import { WebApp, WebAppProvider } from "./WebApp.ts";
import {
  WebAppAuthSettings,
  WebAppAuthSettingsProvider,
} from "./WebAppAuthSettings.ts";
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
  HostNameBinding,
  HybridConnection,
  PublicCertificate,
  SiteCertificate,
  SiteContainer,
  SiteExtension,
  SourceControl,
  StaticSite,
  StaticSiteBasicAuth,
  StaticSiteCustomDomain,
  StaticSiteDatabaseConnection,
  StaticSiteLinkedBackend,
  StaticSiteUserProvidedFunctionApp,
  VirtualNetworkIntegration,
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
    HostNameBindingProvider(),
    HybridConnectionProvider(),
    PublicCertificateProvider(),
    SiteCertificateProvider(),
    SiteContainerProvider(),
    SiteExtensionProvider(),
    SourceControlProvider(),
    StaticSiteProvider(),
    StaticSiteBasicAuthProvider(),
    StaticSiteCustomDomainProvider(),
    StaticSiteDatabaseConnectionProvider(),
    StaticSiteLinkedBackendProvider(),
    StaticSiteUserProvidedFunctionAppProvider(),
    VirtualNetworkIntegrationProvider(),
    WebAppProvider(),
    WebAppAuthSettingsProvider(),
    WebAppBackupConfigurationProvider(),
    WebAppSlotProvider(),
  );
