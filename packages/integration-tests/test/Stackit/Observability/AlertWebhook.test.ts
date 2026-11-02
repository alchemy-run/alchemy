import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, observeInstance, slow } from "./observability.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("observability", "alertwebhook"),
  timeout: 2_700_000,
} as const;

/** The instance, with an optional alert configuration and webhook. */
const app = (options: {
  readonly webhook?: Omit<Stackit.Observability.AlertWebhookProps, "instanceId">;
  readonly groupBy?: string[];
}) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.Observability.Instance("AlertWebhookInstance", {});
    const webhook =
      options.webhook === undefined
        ? undefined
        : yield* Stackit.Observability.AlertWebhook("WebhookUnderTest", {
            instanceId: instance.instanceId,
            ...options.webhook,
          });
    const config =
      options.groupBy === undefined
        ? undefined
        : yield* Stackit.Observability.AlertConfig("WebhookSiblingConfig", {
            instanceId: instance.instanceId,
            receivers: [{ name: "team", emailConfigs: [{ to: "team@example.com" }] }],
            route: { receiver: "team", groupBy: options.groupBy },
            // Not what this suite is about: an instance's own rules may need it.
            replaceInhibitRules: true,
          });
    return { instance, webhook, config };
  });

const URL_ONE = "https://alerts.example.com/one?token=alchemy-test-one";
const URL_TWO = "https://alerts.example.com/two?token=alchemy-test-two";

const observeReceiver = (projectId: string, instanceId: string, receiver: string) =>
  observability
    .listAlertConfigReceivers({ projectId, instanceId })
    .pipe(
      Effect.map(({ data }) => data.find((live) => live.name === receiver) ?? ("gone" as const)),
    );

const observeRoute = (projectId: string, instanceId: string, receiver: string) =>
  observability
    .listAlertConfigRoutes({ projectId, instanceId })
    .pipe(
      Effect.map(
        ({ data }) => data.routes?.find((live) => live.receiver === receiver) ?? ("gone" as const),
      ),
    );

test.provider.skipIf(slow)(
  "create, update and delete a webhook, alongside an alert configuration",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const webhook = { url: Redacted.make(URL_ONE), matchers: ['severity="critical"'] };
      const created = yield* stack.deploy(app({ webhook }));
      const instanceId = created.instance.instanceId;
      const receiverName = created.webhook!.receiverName;
      expect(receiverName).toMatch(/^alchemy-webhook-/);

      // Out of band: the receiver and its route.
      const receiver = yield* observeReceiver(projectId, instanceId, receiverName);
      const firstUrl = receiver === "gone" ? undefined : receiver.webHookConfigs?.[0]?.url;
      expect(Redacted.isRedacted(firstUrl) ? Redacted.value(firstUrl) : firstUrl).toEqual(URL_ONE);
      const route = yield* observeRoute(projectId, instanceId, receiverName);
      expect(route === "gone" ? "gone" : route.continue).toEqual(true);
      expect(route === "gone" ? [] : route.matchers).toEqual(webhook.matchers);

      // `list` enumerates it, by its generated name.
      const provider = yield* Provider.findProvider(Stackit.Observability.AlertWebhook);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.receiverName === receiverName)?.instanceId).toEqual(
        instanceId,
      );

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app({ webhook }));
      expect(plan.resources.WebhookUnderTest).toMatchObject({ action: "noop" });

      // Update in place.
      const updated = yield* stack.deploy(app({ webhook: { url: Redacted.make(URL_TWO) } }));
      expect(updated.webhook!.receiverName).toEqual(receiverName);
      const changed = yield* observeReceiver(projectId, instanceId, receiverName);
      const secondUrl = changed === "gone" ? undefined : changed.webHookConfigs?.[0]?.url;
      expect(Redacted.isRedacted(secondUrl) ? Redacted.value(secondUrl) : secondUrl).toEqual(
        URL_TWO,
      );
      const unrestricted = yield* observeRoute(projectId, instanceId, receiverName);
      expect(unrestricted === "gone" ? "gone" : (unrestricted.matchers ?? [])).toEqual([]);

      // An alert configuration, which writes everything, carries the webhook along.
      const both = { url: Redacted.make(URL_TWO) };
      yield* stack.deploy(app({ webhook: both, groupBy: ["alertname"] }));
      const carried = yield* observeReceiver(projectId, instanceId, receiverName);
      expect(carried === "gone" ? "gone" : "present").toEqual("present");
      const carriedRoute = yield* observeRoute(projectId, instanceId, receiverName);
      expect(carriedRoute === "gone" ? "gone" : "present").toEqual("present");
      const redeployed = yield* stack.deploy(app({ webhook: both, groupBy: ["alertname", "job"] }));
      expect(redeployed.config!.route.groupBy).toEqual(["alertname", "job"]);
      const stillThere = yield* observeReceiver(projectId, instanceId, receiverName);
      expect(stillThere === "gone" ? "gone" : "present").toEqual("present");
      // The URL holds its token, and goes back as it reads: a mask would break delivery.
      const carriedUrl = stillThere === "gone" ? undefined : stillThere.webHookConfigs?.[0]?.url;
      expect(Redacted.isRedacted(carriedUrl) ? Redacted.value(carriedUrl) : carriedUrl).toEqual(
        URL_TWO,
      );

      // Removing the configuration restores what it captured, and keeps the webhook.
      yield* stack.deploy(app({ webhook: both }));
      const kept = yield* observeReceiver(projectId, instanceId, receiverName);
      expect(kept === "gone" ? "gone" : "present").toEqual("present");

      // Removing it from the stack deletes it and leaves the instance.
      yield* stack.deploy(app({}));
      yield* expectGone(observeReceiver(projectId, instanceId, receiverName));
      yield* expectGone(observeRoute(projectId, instanceId, receiverName));
      const instance = yield* observeInstance(projectId, instanceId);
      expect(instance === "gone" ? "gone" : "present").toEqual("present");

      // Both in one deploy: nothing orders them, so they run at the same time. Neither may
      // lose the other's write.
      const scope = { projectId, instanceId };
      const together = yield* stack.deploy(app({ webhook: both, groupBy: ["alertname"] }));
      const togetherName = together.webhook!.receiverName;
      const receiverLive = yield* observeReceiver(projectId, instanceId, togetherName);
      expect(receiverLive === "gone" ? "gone" : "present").toEqual("present");
      const routeLive = yield* observeRoute(projectId, instanceId, togetherName);
      expect(routeLive === "gone" ? "gone" : routeLive.continue).toEqual(true);
      const bothLive = yield* observability.getAlertConfigs(scope);
      expect(bothLive.data.route.receiver).toEqual("team");
      expect(bothLive.data.receivers.map((live) => live.name)).toContain("team");
      expect(
        together.config!.captured.receivers.filter((live) =>
          live.name.startsWith("alchemy-webhook-"),
        ),
      ).toEqual([]);

      // And both out in one deploy: the restore must not bring the webhook back.
      yield* stack.deploy(app({}));
      yield* expectGone(observeReceiver(projectId, instanceId, togetherName));
      yield* expectGone(observeRoute(projectId, instanceId, togetherName));
      const neither = yield* observability.getAlertConfigs(scope);
      expect(neither.data.receivers.map((live) => live.name)).not.toContain("team");

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, instanceId));
    }).pipe(logLevel),
  options,
);
