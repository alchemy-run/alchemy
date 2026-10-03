import * as Layer from "effect/Layer";
import { ManagementGroup, ManagementGroupProvider } from "./ManagementGroup.ts";
import {
  ManagementGroupSubscription,
  ManagementGroupSubscriptionProvider,
} from "./ManagementGroupSubscription.ts";
import { ServiceGroup, ServiceGroupProvider } from "./ServiceGroup.ts";

export const resources = [
  ManagementGroup,
  ManagementGroupSubscription,
  ServiceGroup,
];
export const layers = () =>
  Layer.mergeAll(
    ManagementGroupProvider(),
    ManagementGroupSubscriptionProvider(),
    ServiceGroupProvider(),
  );
