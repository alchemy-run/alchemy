import * as Layer from "effect/Layer";
import {
  AccessPolicyAssignment,
  AccessPolicyAssignmentProvider,
} from "./AccessPolicyAssignment.ts";
import { ManagedRedis, ManagedRedisProvider } from "./ManagedRedis.ts";
import {
  ManagedRedisDatabase,
  ManagedRedisDatabaseProvider,
} from "./ManagedRedisDatabase.ts";

export const resources = [
  AccessPolicyAssignment,
  ManagedRedis,
  ManagedRedisDatabase,
];
export const layers = () =>
  Layer.mergeAll(
    AccessPolicyAssignmentProvider(),
    ManagedRedisProvider(),
    ManagedRedisDatabaseProvider(),
  );
