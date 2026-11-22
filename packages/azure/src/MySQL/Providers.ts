import * as Layer from "effect/Layer";
import { Administrator, AdministratorProvider } from "./Administrator.ts";
import {
  AdvancedThreatProtectionSetting,
  AdvancedThreatProtectionSettingProvider,
} from "./AdvancedThreatProtectionSetting.ts";
import { Configuration, ConfigurationProvider } from "./Configuration.ts";
import { Database, DatabaseProvider } from "./Database.ts";
import { FirewallRule, FirewallRuleProvider } from "./FirewallRule.ts";
import { FlexibleServer, FlexibleServerProvider } from "./FlexibleServer.ts";

export const resources = [
  Administrator,
  AdvancedThreatProtectionSetting,
  Configuration,
  Database,
  FirewallRule,
  FlexibleServer,
];
export const layers = () =>
  Layer.mergeAll(
    AdministratorProvider(),
    AdvancedThreatProtectionSettingProvider(),
    ConfigurationProvider(),
    DatabaseProvider(),
    FirewallRuleProvider(),
    FlexibleServerProvider(),
  );
