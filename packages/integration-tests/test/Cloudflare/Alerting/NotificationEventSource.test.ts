import * as Cloudflare from "@alchemy.run/cloudflare";
import { notificationPath } from "@alchemy.run/cloudflare/Alerting/NotificationEventSource";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as alerting from "@distilled.cloud/cloudflare/alerting";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import NotificationWorker, { IssuePolicy } from "./fixtures/notification-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });
const { executeWhenReady, getWhenReady } = Test;

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const Stack = Effect.gen(function* () {
  const policy = yield* IssuePolicy;
  const worker = yield* NotificationWorker;
  yield* Cloudflare.Workers.IssueAutomation("BoomIssues", {
    policyId: policy.policyId,
    service: worker.workerName,
    afterOccurrences: 1,
  });
  return { policyId: policy.policyId, url: worker.url.as<string>() };
});

const Received = Schema.Struct({
  notifications: Schema.Array(
    Schema.Struct({
      alertType: Schema.optional(Schema.String),
      policyId: Schema.optional(Schema.String),
      text: Schema.String,
    }),
  ),
});

test.provider(
  "consumeNotifications receives a Workers Issues notification",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const { policyId, url } = yield* stack.deploy(Stack);
      const base = url.replace(/\/+$/, "");
      const deliveryUrl = `${base}${notificationPath({ LogicalId: "IssuePolicy" })}`;

      // The event source bound a webhook destination at the Worker onto a
      // policy declared without mechanisms. Cloudflare only creates a
      // destination whose test message the Worker acknowledged.
      const policy = yield* alerting.getPolicy({ accountId, policyId });
      const webhookIds = (policy.mechanisms?.webhooks ?? []).map((w) => w.id);
      expect(webhookIds).toHaveLength(1);
      const webhook = yield* alerting.getDestinationWebhook({
        accountId,
        webhookId: webhookIds[0]!,
      });
      expect(webhook.url).toEqual(deliveryUrl);

      // A delivery without the secret is rejected.
      yield* getWhenReady(base);
      const forged = yield* executeWhenReady(
        HttpClientRequest.post(deliveryUrl).pipe(
          HttpClientRequest.setHeader("cf-webhook-auth", "not-the-secret"),
          HttpClientRequest.bodyJsonUnsafe({ alert_type: "workers_observability_real_time_issue" }),
        ),
      );
      expect(forged.status).toBe(401);

      // A 5xx response is a Workers issue occurrence; the automation notifies the
      // policy, which delivers to the Worker.
      const client = yield* HttpClient.HttpClient;
      yield* Effect.forEach([1, 2, 3], () => client.get(`${base}/boom`), { discard: true });

      const received = yield* client.get(`${base}/received`).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Received)),
        Effect.map(({ notifications }) => notifications),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (notifications) => notifications.length > 0,
          times: 18,
        }),
      );
      expect(received[0]).toMatchObject({
        alertType: "workers_observability_real_time_issue",
        policyId,
      });

      yield* stack.destroy();
      yield* alerting.getDestinationWebhook({ accountId, webhookId: webhookIds[0]! }).pipe(
        Effect.flatMap(() => Effect.fail({ _tag: "StillExists" as const })),
        Effect.catchTag("WebhookNotFound", () => Effect.void),
        Effect.retry({
          while: (e) => e._tag === "StillExists",
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
        }),
      );
    }).pipe(logLevel),
  {
    timeout: 180_000,
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:alerting",
      "provider:cloudflare:worker",
      "live",
    ],
  },
);
