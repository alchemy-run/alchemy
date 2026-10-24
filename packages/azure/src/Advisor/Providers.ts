import * as Layer from "effect/Layer";
import {
  ResourceGroupConfiguration,
  ResourceGroupConfigurationProvider,
} from "./ResourceGroupConfiguration.ts";
import { Suppression, SuppressionProvider } from "./Suppression.ts";

export const resources = [ResourceGroupConfiguration, Suppression];
export const layers = () => Layer.mergeAll(ResourceGroupConfigurationProvider(), SuppressionProvider());
