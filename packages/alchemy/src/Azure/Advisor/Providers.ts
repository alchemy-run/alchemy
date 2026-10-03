import * as Layer from "effect/Layer";
import {
  ResourceGroupConfiguration,
  ResourceGroupConfigurationProvider,
} from "./ResourceGroupConfiguration.ts";

export const resources = [ResourceGroupConfiguration];
export const layers = () =>
  Layer.mergeAll(ResourceGroupConfigurationProvider());
