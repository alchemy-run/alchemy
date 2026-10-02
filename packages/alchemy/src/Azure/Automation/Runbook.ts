import * as automation from "@distilled.cloud/azure/automation";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  ProvisioningTimedOut,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  childNuke,
  createChildName,
  getAccount,
  sameName,
  sameText,
} from "./Common.ts";

export type RunbookType =
  | "PowerShell"
  | "PowerShell72"
  | "PowerShellWorkflow"
  | "Python3"
  | "Python2"
  | "Python"
  | "Script"
  | "Graph"
  | "GraphPowerShell"
  | "GraphPowerShellWorkflow";

export interface RunbookProps {
  /** Resource group of the Automation account. Changing it replaces the runbook. */
  resourceGroup: string;
  /** Automation account that holds the runbook. Changing it replaces the runbook. */
  automationAccount: string;
  /**
   * Runbook name: letters, digits, hyphens, and underscores, starting with a
   * letter (up to 63 characters). If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the runbook.
   */
  name?: string;
  /** Runbook language/runtime. Changing it replaces the runbook. */
  runbookType: RunbookType;
  /**
   * Script source. When set, it is uploaded as the draft and published;
   * a change re-uploads and re-publishes. Omit to leave the runbook empty
   * (in the `New` state) or to manage content elsewhere.
   */
  content?: string;
  /**
   * Name of a {@link RuntimeEnvironment} to run the runbook in (for
   * runtime-environment based runbooks).
   */
  runtimeEnvironment?: string;
  /** Description of the runbook. */
  description?: string;
  /**
   * Write verbose records to the job streams.
   * @default false
   */
  logVerbose?: boolean;
  /**
   * Write progress records to the job streams.
   * @default false
   */
  logProgress?: boolean;
  /**
   * Activity-level tracing for graphical runbooks (0 = off).
   * @default 0
   */
  logActivityTrace?: number;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Runbook extends Resource<
  "Azure.Automation.Runbook",
  RunbookProps,
  {
    /** Name of the runbook. */
    runbookName: string;
    /** ARM resource ID of the runbook. */
    runbookId: string;
    /** Automation account that holds the runbook. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Location of the runbook (the account's location). */
    location: string;
    /** Runbook type. */
    runbookType: string;
    /** Publication state (`New`, `Edit`, `Published`). */
    state: string | undefined;
    /** Description of the runbook. */
    description: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A runbook in an Azure Automation account — a PowerShell or Python script
 * that runs on demand, on a {@link Schedule} (via a {@link JobSchedule}),
 * or from a {@link Webhook}.
 *
 * With `content`, Alchemy uploads the script as the draft and publishes it,
 * and re-publishes whenever the script changes.
 *
 * @see https://learn.microsoft.com/azure/automation/automation-runbook-types
 *
 * ### Creating a Runbook
 * **Example:** PowerShell 7.2 runbook
 * ```typescript
 * const cleanup = yield* Azure.Automation.Runbook("cleanup", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   runbookType: "PowerShell72",
 *   content: 'Write-Output "cleaning up"',
 * });
 * ```
 *
 * **Example:** Python 3 runbook
 * ```typescript
 * const report = yield* Azure.Automation.Runbook("report", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   runbookType: "Python3",
 *   content: 'print("report")',
 *   description: "Nightly report",
 * });
 * ```
 *
 * @resource
 */
export const Runbook = Resource<Runbook>("Azure.Automation.Runbook");

export const getRunbook = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  runbookName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetRunbook({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      runbookName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  name: string,
  runbook: automation.GetRunbookResponse,
): Runbook["Attributes"] => ({
  runbookName: name,
  runbookId: runbook.id ?? "",
  automationAccount,
  resourceGroup,
  location: runbook.location,
  runbookType: runbook.properties?.runbookType ?? "",
  state: runbook.properties?.state,
  description: runbook.properties?.description,
  tags: userTags(runbook.tags),
});

/** Trailing whitespace/newline differences are not content changes. */
const normalizeContent = (content: string | undefined) =>
  content?.replace(/\r\n/g, "\n").trimEnd();

export const RunbookProvider = () =>
  Provider.succeed(Runbook, {
    stables: [
      "runbookName",
      "runbookId",
      "automationAccount",
      "resourceGroup",
      "location",
    ],

    // Runbooks live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        (news.name !== undefined && !sameName(news.name, output.runbookName)) ||
        !sameName(news.runbookType, output.runbookType)
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
        output?.runbookName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getRunbook(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const { resourceGroup, automationAccount } = news;
      const name =
        news.name ?? output?.runbookName ?? (yield* createChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        automationAccountName: automationAccount,
        runbookName: name,
      };
      const get = getRunbook(
        subscriptionId,
        resourceGroup,
        automationAccount,
        name,
      );
      const label = `runbook ${name}`;
      const settings = {
        description: news.description,
        logVerbose: news.logVerbose ?? false,
        logProgress: news.logProgress ?? false,
        logActivityTrace: news.logActivityTrace ?? 0,
      };

      // Observe.
      let observed = yield* get;

      // Ensure + sync settings. The PUT is a synchronous upsert; runbooks
      // must live in their account's location.
      const props = observed?.properties;
      if (
        observed === undefined ||
        !sameText(props?.description, settings.description) ||
        (props?.logVerbose ?? false) !== settings.logVerbose ||
        (props?.logProgress ?? false) !== settings.logProgress ||
        (props?.logActivityTrace ?? 0) !== settings.logActivityTrace ||
        (news.runtimeEnvironment !== undefined &&
          !sameName(props?.runtimeEnvironment, news.runtimeEnvironment)) ||
        tagsDiffer(observed.tags, tags)
      ) {
        const location =
          observed?.location ??
          (yield* getAccount(subscriptionId, resourceGroup, automationAccount))
            ?.location;
        yield* automation.RunbookCreateOrUpdate({
          ...where,
          name,
          location,
          tags,
          properties: {
            runbookType: news.runbookType,
            runtimeEnvironment: news.runtimeEnvironment,
            ...settings,
          },
        });
        observed = yield* waitForProvisioned(label, get, () => undefined, {
          interval: "2 seconds",
          times: 15,
        });
      }

      // Sync content against the observed published script.
      if (news.content !== undefined) {
        const published =
          observed.properties?.state === "Published"
            ? yield* orUndefinedIfNotFound(automation.GetRunbookContent(where))
            : undefined;
        if (
          normalizeContent(published) !== normalizeContent(news.content) ||
          observed.properties?.state !== "Published"
        ) {
          yield* automation.ReplaceRunbookDraftContent({
            ...where,
            body: news.content,
          });
          yield* automation.PublishRunbook(where);
          // Publishing is a long-running operation (202).
          yield* get.pipe(
            Effect.flatMap((runbook) =>
              runbook?.properties?.state === "Published"
                ? Effect.succeed(runbook)
                : Effect.fail("pending" as const),
            ),
            Effect.retry({
              while: (e) => e === "pending",
              schedule: Schedule.spaced("3 seconds"),
              times: 40,
            }),
            Effect.catchIf(
              (e): e is "pending" => e === "pending",
              () =>
                Effect.fail(
                  new ProvisioningTimedOut({
                    resource: label,
                    state: "Edit",
                    message: `${label} was not published after 40 polls`,
                  }),
                ),
            ),
          );
          observed = (yield* get) ?? observed;
        }
      }

      return toAttrs(resourceGroup, automationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteRunbook({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          runbookName: output.runbookName,
        }),
      );
      yield* waitUntilGone(
        `runbook ${output.runbookName}`,
        getRunbook(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.runbookName,
        ),
      );
    }),

    nuke: childNuke,
  });
