import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automation from "@distilled.cloud/azure/automation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import {
  account,
  logLevel,
  subscription,
  tags,
  waitGone,
  sharedAccountTest,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name?: string; isEnabled: boolean; who: string }) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const runbook = yield* Azure.Automation.Runbook("Runbook", {
      ...where,
      runbookType: "PowerShell72",
      content: 'param([object]$WebhookData) Write-Output "hook"',
    });
    const webhook = yield* Azure.Automation.Webhook("Webhook", {
      ...where,
      name: props.name,
      runbook: runbook.runbookName,
      isEnabled: props.isEnabled,
      parameters: { who: props.who },
    });
    return { where, runbook, webhook };
  });

const getWebhook = (
  resourceGroupName: string,
  automationAccountName: string,
  webhookName: string,
) =>
  Effect.gen(function* () {
    return yield* automation.GetWebhook({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      webhookName,
    });
  });

// One webhook call starts one ~seconds-long job (500 free job minutes per
// month), otherwise free.
test.provider(
  "create, invoke, update, replace, and delete a webhook",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, webhook } = yield* stack.deploy(
          program({ isEnabled: true, who: "a" }),
        );
        const get = (name: string) =>
          getWebhook(where.resourceGroup, where.automationAccount, name);
        expect(webhook.uri).toBeDefined();
        const observed = yield* get(webhook.webhookName);
        expect(observed.properties?.isEnabled).toEqual(true);
        expect(observed.properties?.parameters?.who).toEqual("a");

        // The secret URL starts a job.
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.post(Redacted.value(webhook.uri!)).pipe(
          Effect.retry({
            schedule: Schedule.exponential("1 second"),
            times: 5,
          }),
        );
        expect(response.status).toEqual(202);
        const body = (yield* response.json) as { JobIds?: string[] };
        expect(body.JobIds?.length).toEqual(1);

        // In-place: disable and change parameters; the URL is kept.
        const updated = yield* stack.deploy(
          program({ isEnabled: false, who: "b" }),
        );
        expect(updated.webhook.webhookId).toEqual(webhook.webhookId);
        expect(updated.webhook.uri).toBeDefined();
        const reobserved = yield* get(webhook.webhookName);
        expect(reobserved.properties?.isEnabled).toEqual(false);
        expect(reobserved.properties?.parameters?.who).toEqual("b");

        // Replacement: the name is immutable.
        const replaced = yield* stack.deploy(
          program({
            name: "alchemy-test-webhook-renamed",
            isEnabled: false,
            who: "b",
          }),
        );
        expect(replaced.webhook.webhookName).toEqual(
          "alchemy-test-webhook-renamed",
        );
        expect(yield* waitGone(get(webhook.webhookName))).toEqual("gone");

        yield* stack.destroy();
        expect(yield* waitGone(get(replaced.webhook.webhookName))).toEqual(
          "gone",
        );
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
