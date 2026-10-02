import * as automation from "@distilled.cloud/azure/automation";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
  sameName,
  sameRecord,
} from "./Common.ts";

export interface WebhookProps {
  /** Resource group of the Automation account. Changing it replaces the webhook. */
  resourceGroup: string;
  /** Automation account that holds the webhook. Changing it replaces the webhook. */
  automationAccount: string;
  /**
   * Webhook name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the webhook.
   */
  name?: string;
  /**
   * Published {@link Runbook} the webhook starts. Changing it replaces the
   * webhook.
   */
  runbook: string;
  /**
   * When the webhook stops working, as an ISO 8601 timestamp (at most 10
   * years ahead). Changing it replaces the webhook.
   * @default one year after creation
   */
  expiryTime?: string;
  /**
   * Whether the webhook accepts calls.
   * @default true
   */
  isEnabled?: boolean;
  /** Runbook parameters passed to every job the webhook starts. */
  parameters?: Record<string, string>;
  /**
   * Name of a {@link HybridRunbookWorkerGroup} to run jobs on. Omit to run
   * them in Azure.
   */
  runOn?: string;
}

export interface Webhook extends Resource<
  "Azure.Automation.Webhook",
  WebhookProps,
  {
    /** Name of the webhook. */
    webhookName: string;
    /** ARM resource ID of the webhook. */
    webhookId: string;
    /** Automation account that holds the webhook. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Runbook the webhook starts. */
    runbook: string;
    /**
     * Secret URL that starts the runbook (POST). Azure returns it only when
     * the webhook is created, so it is `undefined` for adopted webhooks.
     */
    uri: Redacted.Redacted<string> | undefined;
    /** Expiry time. */
    expiryTime: string | undefined;
    /** Whether the webhook is enabled. */
    isEnabled: boolean;
  },
  never,
  Providers
> {}

/**
 * A webhook that starts a published runbook from a single HTTP POST.
 *
 * The webhook URL is a secret that Azure shows only once, at creation;
 * Alchemy generates it, creates the webhook with it, and keeps it as a
 * `Redacted` attribute.
 *
 * @see https://learn.microsoft.com/azure/automation/automation-webhooks
 *
 * ### Creating a Webhook
 * **Example:** Start a runbook over HTTP
 * ```typescript
 * const runbook = yield* Azure.Automation.Runbook("deploy", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   runbookType: "PowerShell72",
 *   content: 'param($WebhookData) Write-Output $WebhookData.RequestBody',
 * });
 * const hook = yield* Azure.Automation.Webhook("deploy", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   runbook: runbook.runbookName,
 * });
 * // POST to Redacted.value(hook.uri!) to start a job
 * ```
 *
 * @resource
 */
export const Webhook = Resource<Webhook>("Azure.Automation.Webhook");

const getWebhook = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  webhookName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetWebhook({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      webhookName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  name: string,
  webhook: automation.GetWebhookResponse,
  uri: Redacted.Redacted<string> | undefined,
): Webhook["Attributes"] => ({
  webhookName: name,
  webhookId: webhook.id ?? "",
  automationAccount,
  resourceGroup,
  runbook: webhook.properties?.runbook?.name ?? "",
  uri,
  expiryTime: webhook.properties?.expiryTime,
  isEnabled: webhook.properties?.isEnabled ?? false,
});

export const WebhookProvider = () =>
  Provider.succeed(Webhook, {
    stables: [
      "webhookName",
      "webhookId",
      "automationAccount",
      "resourceGroup",
      "runbook",
      "uri",
    ],

    // Webhooks live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        (news.name !== undefined && !sameName(news.name, output.webhookName)) ||
        !sameName(news.runbook, output.runbook) ||
        (olds !== undefined && news.expiryTime !== olds.expiryTime)
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
        output?.webhookName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getWebhook(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        account,
        name,
        observed,
        output?.uri,
      );
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
        news.name ?? output?.webhookName ?? (yield* createChildName(id));
      const isEnabled = news.isEnabled ?? true;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        automationAccountName: automationAccount,
        webhookName: name,
      };
      const get = getWebhook(
        subscriptionId,
        resourceGroup,
        automationAccount,
        name,
      );
      let uri = output?.uri;

      // Observe.
      let observed = yield* get;

      // Ensure. The secret URL is generated first and only known now.
      if (observed === undefined) {
        const generated = yield* automation.GenerateWebhookUri({
          subscriptionId,
          resourceGroupName: resourceGroup,
          automationAccountName: automationAccount,
        });
        uri = Redacted.make(generated);
        // Azure rejects a webhook without an expiry time.
        const expiryTime =
          news.expiryTime ??
          (yield* Effect.sync(() =>
            new Date(Date.now() + 365 * 24 * 3600_000).toISOString(),
          ));
        yield* automation.WebhookCreateOrUpdate({
          ...where,
          name,
          properties: {
            uri: generated,
            runbook: { name: news.runbook },
            isEnabled,
            expiryTime,
            parameters: news.parameters,
            runOn: news.runOn,
          },
        });
        observed = yield* waitForProvisioned(
          `webhook ${name}`,
          get,
          () => undefined,
          { interval: "2 seconds", times: 15 },
        );
      }

      // Sync the mutable aspects against observed.
      const props = observed.properties;
      if (
        props?.isEnabled !== isEnabled ||
        !sameRecord(props?.parameters, news.parameters) ||
        (props?.runOn || undefined) !== news.runOn
      ) {
        observed = yield* automation.UpdateWebhook({
          ...where,
          name,
          properties: {
            isEnabled,
            parameters: news.parameters ?? {},
            runOn: news.runOn ?? "",
          },
        });
      }

      return toAttrs(resourceGroup, automationAccount, name, observed, uri);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteWebhook({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          webhookName: output.webhookName,
        }),
      );
      yield* waitUntilGone(
        `webhook ${output.webhookName}`,
        getWebhook(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.webhookName,
        ),
      );
    }),

    nuke: childNuke,
  });
