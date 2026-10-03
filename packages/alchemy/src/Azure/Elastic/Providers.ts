import * as Layer from "effect/Layer";
import { Monitor, MonitorProvider } from "./Monitor.ts";
import {
  MonitoredSubscriptions,
  MonitoredSubscriptionsProvider,
} from "./MonitoredSubscriptions.ts";
import {
  OpenAIIntegration,
  OpenAIIntegrationProvider,
} from "./OpenAIIntegration.ts";
import { TagRule, TagRuleProvider } from "./TagRule.ts";

export const resources = [
  Monitor,
  MonitoredSubscriptions,
  OpenAIIntegration,
  TagRule,
];
export const layers = () =>
  Layer.mergeAll(
    MonitorProvider(),
    MonitoredSubscriptionsProvider(),
    OpenAIIntegrationProvider(),
    TagRuleProvider(),
  );
