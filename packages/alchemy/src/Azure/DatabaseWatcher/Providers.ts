import * as Layer from "effect/Layer";
import {
  AlertRuleResource,
  AlertRuleResourceProvider,
} from "./AlertRuleResource.ts";
import {
  SharedPrivateLinkResource,
  SharedPrivateLinkResourceProvider,
} from "./SharedPrivateLinkResource.ts";
import { Target, TargetProvider } from "./Target.ts";
import { Watcher, WatcherProvider } from "./Watcher.ts";

export const resources = [
  AlertRuleResource,
  SharedPrivateLinkResource,
  Target,
  Watcher,
];
export const layers = () =>
  Layer.mergeAll(
    AlertRuleResourceProvider(),
    SharedPrivateLinkResourceProvider(),
    TargetProvider(),
    WatcherProvider(),
  );
