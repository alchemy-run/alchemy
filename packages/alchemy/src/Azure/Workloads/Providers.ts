import * as Layer from "effect/Layer";
import { Monitor, MonitorProvider } from "./Monitor.ts";
import { ProviderInstance, ProviderInstanceProvider } from "./ProviderInstance.ts";
import {
  SapLandscapeMonitor,
  SapLandscapeMonitorProvider,
} from "./SapLandscapeMonitor.ts";
import {
  SapVirtualInstance,
  SapVirtualInstanceProvider,
} from "./SapVirtualInstance.ts";

export const resources = [
  Monitor,
  ProviderInstance,
  SapLandscapeMonitor,
  SapVirtualInstance,
];
export const layers = () =>
  Layer.mergeAll(
    MonitorProvider(),
    ProviderInstanceProvider(),
    SapLandscapeMonitorProvider(),
    SapVirtualInstanceProvider(),
  );
