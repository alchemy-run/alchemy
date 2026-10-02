import * as Layer from "effect/Layer";
import { AiGateway, AiGatewayProvider } from "./AiGateway.ts";
import {
  AppServiceEnvironment,
  AppServiceEnvironmentProvider,
} from "./AppServiceEnvironment.ts";
import { AppServicePlan, AppServicePlanProvider } from "./AppServicePlan.ts";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import { FunctionApp, FunctionAppProvider } from "./FunctionApp.ts";
import {
  FunctionAppHostKey,
  FunctionAppHostKeyProvider,
} from "./FunctionAppHostKey.ts";
import { HostNameBinding, HostNameBindingProvider } from "./HostNameBinding.ts";
import { SiteContainer, SiteContainerProvider } from "./SiteContainer.ts";
import { SourceControl, SourceControlProvider } from "./SourceControl.ts";
import { StaticSite, StaticSiteProvider } from "./StaticSite.ts";
import {
  StaticSiteCustomDomain,
  StaticSiteCustomDomainProvider,
} from "./StaticSiteCustomDomain.ts";
import {
  StaticSiteLinkedBackend,
  StaticSiteLinkedBackendProvider,
} from "./StaticSiteLinkedBackend.ts";
import {
  VirtualNetworkIntegration,
  VirtualNetworkIntegrationProvider,
} from "./VirtualNetworkIntegration.ts";
import { WebApp, WebAppProvider } from "./WebApp.ts";
import {
  WebAppAuthSettings,
  WebAppAuthSettingsProvider,
} from "./WebAppAuthSettings.ts";
import { WebAppSlot, WebAppSlotProvider } from "./WebAppSlot.ts";

export const resources = [
  AiGateway,
  AppServiceEnvironment,
  AppServicePlan,
  Certificate,
  FunctionApp,
  FunctionAppHostKey,
  HostNameBinding,
  SiteContainer,
  SourceControl,
  StaticSite,
  StaticSiteCustomDomain,
  StaticSiteLinkedBackend,
  VirtualNetworkIntegration,
  WebApp,
  WebAppAuthSettings,
  WebAppSlot,
];
export const layers = () =>
  Layer.mergeAll(
    AiGatewayProvider(),
    AppServiceEnvironmentProvider(),
    AppServicePlanProvider(),
    CertificateProvider(),
    FunctionAppProvider(),
    FunctionAppHostKeyProvider(),
    HostNameBindingProvider(),
    SiteContainerProvider(),
    SourceControlProvider(),
    StaticSiteProvider(),
    StaticSiteCustomDomainProvider(),
    StaticSiteLinkedBackendProvider(),
    VirtualNetworkIntegrationProvider(),
    WebAppProvider(),
    WebAppAuthSettingsProvider(),
    WebAppSlotProvider(),
  );
