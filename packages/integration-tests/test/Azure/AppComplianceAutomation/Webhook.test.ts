import * as Azure from "@alchemy.run/azure";
import * as acat from "@distilled.cloud/azure/appcomplianceautomation";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { gone, logLevel, reportProgram, tags, userToken } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getWebhook = (reportName: string, webhookName: string) =>
  Effect.flatMap(userToken, (token) =>
    acat.GetWebhook({ reportName, webhookName, userToken: token }),
  );

const program = (props: {
  name?: string;
  events?: Azure.AppComplianceAutomation.WebhookEvent[];
  status: "Enabled" | "Disabled";
}) =>
  Effect.gen(function* () {
    const { report } = yield* reportProgram;
    const webhook = yield* Azure.AppComplianceAutomation.Webhook("Webhook", {
      reportName: report.reportName,
      name: props.name,
      payloadUrl: "https://example.com/alchemy-acat-webhook",
      events: props.events,
      status: props.status,
      webhookKey: Redacted.make("alchemy-test-webhook-secret"),
    });
    return { report, webhook };
  });

// Free; seconds.
test.provider(
  "reading a webhook of a missing report is a typed not-found",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* getWebhook("alchemy-acat-probe", "probe").pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);

// Skipped: the parent report cannot be created by the testing service
// principal: HTTP 502 `BearerFallbackDisabled` ("Server failed to process the
// request."), see Report.test.ts. Storage account (~$0) + report (free); ~5 min.
test.provider.skip(
  "create, update, replace, and delete an app compliance webhook",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { report, webhook } = yield* stack.deploy(program({ status: "Enabled" }));
      expect(webhook.reportName).toEqual(report.reportName);
      expect(webhook.sendAllEvents).toEqual(true);
      expect(webhook.webhookKeyEnabled).toEqual(true);
      const observed = yield* getWebhook(report.reportName, webhook.webhookName);
      expect(observed.properties.payloadUrl).toEqual("https://example.com/alchemy-acat-webhook");
      expect(observed.properties.status).toEqual("Enabled");

      // In place: events and status.
      const updated = yield* stack.deploy(
        program({ events: ["assessment_failure"], status: "Disabled" }),
      );
      expect(updated.webhook.webhookName).toEqual(webhook.webhookName);
      const reobserved = yield* getWebhook(report.reportName, webhook.webhookName);
      expect(reobserved.properties.status).toEqual("Disabled");
      expect(reobserved.properties.sendAllEvents).toEqual("false");
      expect(reobserved.properties.events).toEqual(["assessment_failure"]);

      // Replacement: the name is the webhook's identity.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-test-acat-webhook-replaced",
          events: ["assessment_failure"],
          status: "Disabled",
        }),
      );
      expect(replaced.webhook.webhookName).toEqual("alchemy-test-acat-webhook-replaced");
      const replacedOne = yield* gone(getWebhook(report.reportName, webhook.webhookName));
      expect(replacedOne).toEqual("gone");

      yield* stack.destroy();
      const destroyed = yield* gone(getWebhook(report.reportName, replaced.webhook.webhookName));
      expect(destroyed).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
