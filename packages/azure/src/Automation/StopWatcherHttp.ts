import * as automation from "@distilled.cloud/azure/automation";
import * as Layer from "effect/Layer";
import { AutomationRole, makeWatcherActionBinding } from "./BindingHttp.ts";
import { StopWatcher } from "./StopWatcher.ts";

/**
 * Implementation of {@link StopWatcher} over the distilled `automation` ARM
 * API. Assigns the custom `AzureAutomationStopWatcherRole` on the watcher.
 *
 * @layer
 * @provides Azure.Automation.StopWatcher
 */
export const StopWatcherHttp = Layer.effect(
  StopWatcher,
  makeWatcherActionBinding({
    tag: "Azure.Automation.StopWatcher",
    operation: automation.StopWatcher,
    role: AutomationRole.StopWatcher,
  }),
);
