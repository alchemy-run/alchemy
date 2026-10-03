import * as Layer from "effect/Layer";
import { Cluster, ClusterProvider } from "./Cluster.ts";
import {
  CoordinatorConfiguration,
  CoordinatorConfigurationProvider,
} from "./CoordinatorConfiguration.ts";
import { FirewallRule, FirewallRuleProvider } from "./FirewallRule.ts";
import {
  NodeConfiguration,
  NodeConfigurationProvider,
} from "./NodeConfiguration.ts";
import { Role, RoleProvider } from "./Role.ts";

export const resources = [
  Cluster,
  CoordinatorConfiguration,
  FirewallRule,
  NodeConfiguration,
  Role,
];
export const layers = () =>
  Layer.mergeAll(
    ClusterProvider(),
    CoordinatorConfigurationProvider(),
    FirewallRuleProvider(),
    NodeConfigurationProvider(),
    RoleProvider(),
  );
