import * as Layer from "effect/Layer";
import { Administrator, AdministratorProvider } from "./Administrator.ts";
import {
  AdvancedThreatProtectionSettings,
  AdvancedThreatProtectionSettingsProvider,
} from "./AdvancedThreatProtectionSettings.ts";
import { Backup, BackupProvider } from "./Backup.ts";
import { Configuration, ConfigurationProvider } from "./Configuration.ts";
import { Database, DatabaseProvider } from "./Database.ts";
import { FirewallRule, FirewallRuleProvider } from "./FirewallRule.ts";
import { FlexibleServer, FlexibleServerProvider } from "./FlexibleServer.ts";
import { VirtualEndpoint, VirtualEndpointProvider } from "./VirtualEndpoint.ts";

export const resources = [
  Administrator,
  AdvancedThreatProtectionSettings,
  Backup,
  Configuration,
  Database,
  FirewallRule,
  FlexibleServer,
  VirtualEndpoint,
];
export const layers = () =>
  Layer.mergeAll(
    AdministratorProvider(),
    AdvancedThreatProtectionSettingsProvider(),
    BackupProvider(),
    ConfigurationProvider(),
    DatabaseProvider(),
    FirewallRuleProvider(),
    FlexibleServerProvider(),
    VirtualEndpointProvider(),
  );
