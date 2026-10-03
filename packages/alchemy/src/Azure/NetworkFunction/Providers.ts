import * as Layer from "effect/Layer";
import {
  AzureTrafficCollector,
  AzureTrafficCollectorProvider,
} from "./AzureTrafficCollector.ts";
import { CollectorPolicy, CollectorPolicyProvider } from "./CollectorPolicy.ts";

export const resources = [AzureTrafficCollector, CollectorPolicy];
export const layers = () =>
  Layer.mergeAll(AzureTrafficCollectorProvider(), CollectorPolicyProvider());
