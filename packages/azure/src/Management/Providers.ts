import * as Layer from "effect/Layer";
import { HierarchySettings, HierarchySettingsProvider } from "./HierarchySettings.ts";
import { ManagementGroup, ManagementGroupProvider } from "./ManagementGroup.ts";
import {
  ManagementGroupSubscription,
  ManagementGroupSubscriptionProvider,
} from "./ManagementGroupSubscription.ts";
import { ServiceGroup, ServiceGroupProvider } from "./ServiceGroup.ts";

export const resources = [
  HierarchySettings,
  ManagementGroup,
  ManagementGroupSubscription,
  ServiceGroup,
];
export const layers = () =>
  Layer.mergeAll(
    HierarchySettingsProvider(),
    ManagementGroupProvider(),
    ManagementGroupSubscriptionProvider(),
    ServiceGroupProvider(),
  );
