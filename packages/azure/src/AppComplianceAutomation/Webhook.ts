import * as acat from "@distilled.cloud/azure/appcomplianceautomation";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { flag, generatedName, REPORTS_PREFIX, sameName, userToken } from "./internal.ts";

/** An App Compliance Automation event a webhook can subscribe to. */
export type WebhookEvent =
  | "generate_snapshot_success"
  | "generate_snapshot_failed"
  | "assessment_failure"
  | "report_configuration_changes"
  | "report_deletion";

export interface WebhookProps {
  /** Name of the report, e.g. `report.reportName`. Changing it replaces the webhook. */
  reportName: string;
  /**
   * Webhook name, unique in the report: 1-50 letters, digits, `-` and `_`.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the webhook.
   */
  name?: string;
  /** URL that receives the notification POST requests, `http(s)://...`. */
  payloadUrl: string;
  /**
   * Events that trigger a notification. Omit to receive every event.
   * @default every event
   */
  events?: WebhookEvent[];
  /**
   * Whether the webhook sends notifications.
   * @default "Enabled"
   */
  status?: "Enabled" | "Disabled";
  /**
   * Secret the service signs each payload with (the `x-acat-signature-256`
   * header), up to 2048 characters. Omit to send unsigned payloads.
   */
  webhookKey?: string | Redacted.Redacted<string>;
  /**
   * Whether the service verifies the TLS certificate of an `https` payload URL.
   * @default true
   */
  enableSslVerification?: boolean;
}

export interface Webhook extends Resource<
  "Azure.AppComplianceAutomation.Webhook",
  WebhookProps,
  {
    /** Webhook name. */
    webhookName: string;
    /** ARM ID of the webhook. */
    webhookResourceId: string;
    /** Report that holds the webhook. */
    reportName: string;
    /** The service's own ID of the webhook. */
    webhookId: string | undefined;
    /** `Enabled` or `Disabled`. */
    status: string | undefined;
    /** URL that receives the notifications. */
    payloadUrl: string | undefined;
    /** Subscribed events (empty when every event is sent). */
    events: string[];
    /** Whether every event is sent. */
    sendAllEvents: boolean;
    /** Whether payloads are signed with a secret. */
    webhookKeyEnabled: boolean;
  },
  never,
  Providers
> {}

/**
 * A notification webhook of an App Compliance Automation Tool (ACAT) report
 * (`Microsoft.AppComplianceAutomation/reports/webhooks`). The service POSTs
 * a JSON payload to the URL when a snapshot is generated, an assessment
 * fails, or the report changes.
 *
 * Webhooks carry no tags: Alchemy recognises its own webhook by the
 * generated name, so an explicit `name` that already exists is only taken
 * over with `--adopt`.
 *
 * :::caution
 * Changing `reportName` or `name` replaces the webhook.
 * :::
 *
 * @see https://learn.microsoft.com/microsoft-365-app-certification/docs/keep-application-compliant-continuously-with-acat
 *
 * ### Creating a Webhook
 * **Example:** Notify on failed assessments
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("evidence");
 * const report = yield* Azure.AppComplianceAutomation.Report("m365-cert", {
 *   resources: [{ resourceId: account.storageAccountId }],
 * });
 * const hook = yield* Azure.AppComplianceAutomation.Webhook("alerts", {
 *   reportName: report.reportName,
 *   payloadUrl: "https://example.com/acat",
 *   events: ["assessment_failure", "generate_snapshot_failed"],
 *   webhookKey: Redacted.make("signing-secret"),
 * });
 * ```
 *
 * @resource
 */
export const Webhook = Resource<Webhook>("Azure.AppComplianceAutomation.Webhook");

interface Where {
  reportName: string;
  webhookName: string;
}

const getWebhook = (where: Where) =>
  Effect.gen(function* () {
    const token = yield* userToken;
    return yield* orUndefinedIfNotFound(acat.GetWebhook({ ...where, userToken: token }));
  });

const toAttrs = (where: Where, observed: acat.GetWebhookResponse): Webhook["Attributes"] => ({
  webhookName: where.webhookName,
  webhookResourceId:
    observed.id ?? `${REPORTS_PREFIX}${where.reportName}/webhooks/${where.webhookName}`,
  reportName: where.reportName,
  webhookId: observed.properties.webhookId,
  status: observed.properties.status,
  payloadUrl: observed.properties.payloadUrl,
  events: [...(observed.properties.events ?? [])],
  sendAllEvents: flag(observed.properties.sendAllEvents) ?? false,
  webhookKeyEnabled: flag(observed.properties.webhookKeyEnabled) ?? false,
});

const keyValue = (key: string | Redacted.Redacted<string> | undefined) =>
  key === undefined ? undefined : Redacted.isRedacted(key) ? Redacted.value(key) : key;

const sameEvents = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((event) => b.includes(event));

export const WebhookProvider = () =>
  Provider.succeed(Webhook, {
    stables: ["webhookName", "webhookResourceId", "reportName"],

    // Webhooks live inside a report; deleting the report removes them.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.reportName, output.reportName) ||
        (news.name !== undefined && !sameName(news.name, output.webhookName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const reportName = output?.reportName ?? olds?.reportName;
      if (reportName === undefined) return undefined;
      const generated = yield* generatedName(id, instanceId);
      const where = { reportName, webhookName: output?.webhookName ?? olds?.name ?? generated };
      const observed = yield* getWebhook(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      return output !== undefined || where.webhookName === generated ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
      const where = {
        reportName: news.reportName,
        webhookName: news.name ?? output?.webhookName ?? (yield* generatedName(id, instanceId)),
      };
      const token = yield* userToken;
      const sendAllEvents = news.events === undefined;
      const events = news.events ?? [];
      const status = news.status ?? "Enabled";
      const enableSslVerification = news.enableSslVerification ?? true;
      const key = keyValue(news.webhookKey);
      const properties = {
        payloadUrl: news.payloadUrl,
        sendAllEvents,
        events,
        status,
        contentType: "application/json",
        enableSslVerification,
      } as const;

      // Observe.
      const observed = yield* getWebhook(where);

      // Ensure.
      if (observed === undefined) {
        yield* acat.WebhookCreateOrUpdate({
          ...where,
          userToken: token,
          properties: {
            ...properties,
            webhookKey: key,
            updateWebhookKey: key !== undefined,
          },
        });
      } else {
        // Sync against the observed webhook. The secret cannot be read back:
        // the service only reports whether one is set, so a changed value is
        // detected against the previous props.
        const current = observed.properties;
        const keyEnabled = flag(current.webhookKeyEnabled) ?? false;
        const keyChanged =
          key === undefined
            ? keyEnabled
            : !keyEnabled || olds === undefined || keyValue(olds.webhookKey) !== key;
        const settingsChanged =
          current.payloadUrl !== properties.payloadUrl ||
          (flag(current.sendAllEvents) ?? false) !== sendAllEvents ||
          !sameEvents(current.events ?? [], events) ||
          current.status !== status ||
          (flag(current.enableSslVerification) ?? true) !== enableSslVerification;
        if (keyChanged || settingsChanged) {
          yield* acat.UpdateWebhook({
            ...where,
            userToken: token,
            properties: {
              ...properties,
              ...(keyChanged ? { webhookKey: key ?? "", updateWebhookKey: true } : {}),
            },
          });
        }
      }

      const fresh = yield* waitForProvisioned(
        `app compliance webhook ${where.webhookName}`,
        getWebhook(where),
        (webhook) => webhook.properties.provisioningState,
        { interval: "3 seconds", times: 20 },
      );
      return toAttrs(where, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const where = { reportName: output.reportName, webhookName: output.webhookName };
      const token = yield* userToken;
      yield* ignoreNotFound(acat.DeleteWebhook({ ...where, userToken: token }));
      yield* waitUntilGone(`app compliance webhook ${output.webhookName}`, getWebhook(where));
    }),

    nuke: { dependsOn: ["Azure.AppComplianceAutomation.Report"] },
  });
