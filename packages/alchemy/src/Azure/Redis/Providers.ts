import * as Layer from "effect/Layer";
import { AccessPolicy, AccessPolicyProvider } from "./AccessPolicy.ts";
import {
  AccessPolicyAssignment,
  AccessPolicyAssignmentProvider,
} from "./AccessPolicyAssignment.ts";
import { Cache, CacheProvider } from "./Cache.ts";
import { FirewallRule, FirewallRuleProvider } from "./FirewallRule.ts";
import { LinkedServer, LinkedServerProvider } from "./LinkedServer.ts";
import { ManagedRedis, ManagedRedisProvider } from "./ManagedRedis.ts";
import {
  ManagedRedisDatabase,
  ManagedRedisDatabaseProvider,
} from "./ManagedRedisDatabase.ts";
import { PatchSchedule, PatchScheduleProvider } from "./PatchSchedule.ts";

export const resources = [
  AccessPolicy,
  AccessPolicyAssignment,
  Cache,
  FirewallRule,
  LinkedServer,
  ManagedRedis,
  ManagedRedisDatabase,
  PatchSchedule,
];
export const layers = () =>
  Layer.mergeAll(
    AccessPolicyProvider(),
    AccessPolicyAssignmentProvider(),
    CacheProvider(),
    FirewallRuleProvider(),
    LinkedServerProvider(),
    ManagedRedisProvider(),
    ManagedRedisDatabaseProvider(),
    PatchScheduleProvider(),
  );
