import * as automation from "@distilled.cloud/azure/automation";
import * as Layer from "effect/Layer";
import { AutomationRole, makeWatcherActionBinding } from "./BindingHttp.ts";
import { StartWatcher } from "./StartWatcher.ts";

/**
 * Implementation of {@link StartWatcher} over the distilled `automation` ARM
 * API. Assigns the custom `AzureAutomationStartWatcherRole` on the watcher.
 *
 * @layer
 * @provides Azure.Automation.StartWatcher
 */
export const StartWatcherHttp = Layer.effect(
  StartWatcher,
  makeWatcherActionBinding({
    tag: "Azure.Automation.StartWatcher",
    operation: automation.StartWatcher,
    role: AutomationRole.StartWatcher,
  }),
);
