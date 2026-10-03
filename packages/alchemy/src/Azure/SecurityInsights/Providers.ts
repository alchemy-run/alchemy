import * as Layer from "effect/Layer";
import { AlertRule, AlertRuleProvider } from "./AlertRule.ts";
import { AlertRuleAction, AlertRuleActionProvider } from "./AlertRuleAction.ts";
import { AutomationRule, AutomationRuleProvider } from "./AutomationRule.ts";
import { ContentPackage, ContentPackageProvider } from "./ContentPackage.ts";
import { ContentTemplate, ContentTemplateProvider } from "./ContentTemplate.ts";
import { DataConnector, DataConnectorProvider } from "./DataConnector.ts";
import {
  DataConnectorDefinition,
  DataConnectorDefinitionProvider,
} from "./DataConnectorDefinition.ts";
import { Metadata, MetadataProvider } from "./Metadata.ts";
import { OnboardingState, OnboardingStateProvider } from "./OnboardingState.ts";
import {
  SecurityMLAnalyticsSetting,
  SecurityMLAnalyticsSettingProvider,
} from "./SecurityMLAnalyticsSetting.ts";
import { SourceControl, SourceControlProvider } from "./SourceControl.ts";
import { Watchlist, WatchlistProvider } from "./Watchlist.ts";
import { WatchlistItem, WatchlistItemProvider } from "./WatchlistItem.ts";

export const resources = [
  AlertRule,
  AlertRuleAction,
  AutomationRule,
  ContentPackage,
  ContentTemplate,
  DataConnector,
  DataConnectorDefinition,
  Metadata,
  OnboardingState,
  SecurityMLAnalyticsSetting,
  SourceControl,
  Watchlist,
  WatchlistItem,
];
export const layers = () =>
  Layer.mergeAll(
    AlertRuleProvider(),
    AlertRuleActionProvider(),
    AutomationRuleProvider(),
    ContentPackageProvider(),
    ContentTemplateProvider(),
    DataConnectorProvider(),
    DataConnectorDefinitionProvider(),
    MetadataProvider(),
    OnboardingStateProvider(),
    SecurityMLAnalyticsSettingProvider(),
    SourceControlProvider(),
    WatchlistProvider(),
    WatchlistItemProvider(),
  );
