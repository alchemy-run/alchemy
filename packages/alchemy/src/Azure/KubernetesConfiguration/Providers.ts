import * as Layer from "effect/Layer";
import { Extension, ExtensionProvider } from "./Extension.ts";
import {
  FluxConfiguration,
  FluxConfigurationProvider,
} from "./FluxConfiguration.ts";

export const resources = [Extension, FluxConfiguration];
export const layers = () =>
  Layer.mergeAll(ExtensionProvider(), FluxConfigurationProvider());
