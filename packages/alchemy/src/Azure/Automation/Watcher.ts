import * as automation from "@distilled.cloud/azure/automation";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  accountOwnedByStage,
  childNuke,
  createChildName,
  getAccount,
  sameName,
  sameRecord,
  sameText,
} from "./Common.ts";

export interface WatcherProps {
  /** Resource group of the Automation account. Changing it replaces the watcher. */
  resourceGroup: string;
  /** Automation account that holds the watcher. Changing it replaces the watcher. */
  automationAccount: string;
  /**
   * Watcher name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the watcher.
   */
  name?: string;
  /** Watcher {@link Runbook} that checks for the condition. Changing it replaces the watcher. */
  scriptName: string;
  /**
   * {@link HybridRunbookWorkerGroup} the watcher runbook runs on; watcher
   * tasks only run on hybrid workers. Changing it replaces the watcher.
   */
  scriptRunOn: string;
  /** Parameters passed to the watcher runbook. Changing them replaces the watcher. */
  scriptParameters?: Record<string, string>;
  /**
   * How often the watcher runbook runs, in seconds. Changing it replaces
   * the watcher.
   * @default 30
   */
  executionFrequencyInSeconds?: number;
  /** Description of the watcher. Changing it replaces the watcher. */
  description?: string;
}

export interface Watcher extends Resource<
  "Azure.Automation.Watcher",
  WatcherProps,
  {
    /** Name of the watcher. */
    watcherName: string;
    /** ARM resource ID of the watcher. */
    watcherId: string;
    /** Automation account that holds the watcher. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Watcher status (e.g. `Stopped`, `Running`). */
    status: string | undefined;
    /** Execution frequency in seconds. */
    executionFrequencyInSeconds: number | undefined;
  },
  never,
  Providers
> {}

/**
 * A watcher task in an Azure Automation account: a runbook that runs on a
 * hybrid worker every few seconds to detect a condition (and starts an
 * action runbook when it occurs). Created stopped. Watchers do not keep
 * tags, so ownership is inferred from the parent account's tags.
 *
 * Watcher tasks are a legacy feature; prefer Event Grid or Logic Apps for
 * new event-driven automation.
 *
 * @see https://learn.microsoft.com/azure/automation/automation-scenario-using-watcher-task
 *
 * ### Creating a Watcher
 * **Example:** Folder watcher on a hybrid worker group
 * ```typescript
 * const watcher = yield* Azure.Automation.Watcher("folder", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   scriptName: watchRunbook.runbookName,
 *   scriptRunOn: workers.hybridRunbookWorkerGroupName,
 *   executionFrequencyInSeconds: 60,
 * });
 * ```
 *
 * @resource
 */
export const Watcher = Resource<Watcher>("Azure.Automation.Watcher");

const getWatcher = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  watcherName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetWatcher({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      watcherName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  name: string,
  watcher: automation.GetWatcherResponse,
): Watcher["Attributes"] => ({
  watcherName: name,
  watcherId: watcher.id ?? "",
  automationAccount,
  resourceGroup,
  status: watcher.properties?.status,
  executionFrequencyInSeconds: watcher.properties?.executionFrequencyInSeconds,
});

export const WatcherProvider = () =>
  Provider.succeed(Watcher, {
    stables: ["watcherName", "watcherId", "automationAccount", "resourceGroup"],

    // Watchers live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        (news.name !== undefined && !sameName(news.name, output.watcherName)) ||
        (olds !== undefined &&
          (!sameName(news.scriptName, olds.scriptName) ||
            !sameName(news.scriptRunOn, olds.scriptRunOn) ||
            !sameRecord(news.scriptParameters, olds.scriptParameters) ||
            !sameText(news.description, olds.description) ||
            (news.executionFrequencyInSeconds ?? 30) !==
              (olds.executionFrequencyInSeconds ?? 30)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.automationAccount ?? olds?.automationAccount;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.watcherName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getWatcher(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* accountOwnedByStage(
        subscriptionId,
        resourceGroup,
        account,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const { resourceGroup, automationAccount } = news;
      const name =
        news.name ?? output?.watcherName ?? (yield* createChildName(id));
      const frequency = news.executionFrequencyInSeconds ?? 30;
      const get = getWatcher(
        subscriptionId,
        resourceGroup,
        automationAccount,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Existence-only: a PUT on an existing watcher does not change
      // it, and PATCH only works on stopped watchers (a watcher whose group
      // has no workers is "Failed" and cannot be stopped), so every change
      // is a replacement.
      if (observed === undefined) {
        const location = (yield* getAccount(
          subscriptionId,
          resourceGroup,
          automationAccount,
        ))?.location;
        yield* automation.WatcherCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          automationAccountName: automationAccount,
          watcherName: name,
          location,
          properties: {
            executionFrequencyInSeconds: frequency,
            scriptName: news.scriptName,
            scriptRunOn: news.scriptRunOn,
            scriptParameters: news.scriptParameters,
            description: news.description,
          },
        });
        observed = yield* waitForProvisioned(
          `watcher ${name}`,
          get,
          () => undefined,
          { interval: "2 seconds", times: 15 },
        );
      }

      return toAttrs(resourceGroup, automationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteWatcher({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          watcherName: output.watcherName,
        }),
      );
      yield* waitUntilGone(
        `watcher ${output.watcherName}`,
        getWatcher(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.watcherName,
        ),
      );
    }),

    nuke: childNuke,
  });
