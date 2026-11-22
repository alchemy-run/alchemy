import * as Layer from "effect/Layer";
import { Evidence, EvidenceProvider } from "./Evidence.ts";
import { Report, ReportProvider } from "./Report.ts";
import { ScopingConfiguration, ScopingConfigurationProvider } from "./ScopingConfiguration.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";

export const resources = [Evidence, Report, ScopingConfiguration, Webhook];
export const layers = () =>
  Layer.mergeAll(
    EvidenceProvider(),
    ReportProvider(),
    ScopingConfigurationProvider(),
    WebhookProvider(),
  );
