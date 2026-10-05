import * as Layer from "effect/Layer";
import { Monitor, MonitorProvider } from "./Monitor.ts";
import {
  MonitoredSubscriptions,
  MonitoredSubscriptionsProvider,
} from "./MonitoredSubscriptions.ts";
import {
  SingleSignOnConfiguration,
  SingleSignOnConfigurationProvider,
} from "./SingleSignOnConfiguration.ts";
import { TagRule, TagRuleProvider } from "./TagRule.ts";

export const resources = [
  Monitor,
  MonitoredSubscriptions,
  SingleSignOnConfiguration,
  TagRule,
];
export const layers = () =>
  Layer.mergeAll(
    MonitorProvider(),
    MonitoredSubscriptionsProvider(),
    SingleSignOnConfigurationProvider(),
    TagRuleProvider(),
  );
