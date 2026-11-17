import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as alerting from "@distilled.cloud/cloudflare/alerting";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { expectDeployFails, missingName } from "../../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:alerting", "live"];

const EMAIL = "alerts@alchemy-test-2.us";

// The target belongs to another stack, as a lookup's target always should.
// Cloudflare test-POSTs a webhook's URL on create, so the receiver Worker
// comes first; the webhook's reconcile rides out a not-yet-serving URL.
const TargetStack = Alchemy.Stack(
  "AlertingWebhookLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const receiver = yield* Cloudflare.Worker("lookup-receiver", {
      main: pathe.resolve(import.meta.dirname, "fixtures/webhook-receiver.ts"),
      workersDev: true,
    });
    const webhook = yield* Cloudflare.Alerting.NotificationWebhook("lookup-target", {
      url: receiver.url.as<string>(),
    });
    return { webhookId: webhook.webhookId.as<string>(), name: webhook.name.as<string>() };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up webhook receives a new policy's notifications, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { webhookId, name } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Alerting.NotificationWebhook.lookup({ name });
        const byId = Cloudflare.Alerting.NotificationWebhook.lookup({ webhookId });
        const policy = yield* Cloudflare.Alerting.NotificationPolicy("webhook-lookup-policy", {
          alertType: "universal_ssl_event_type",
          mechanisms: { webhooks: [{ id: byName.webhookId }], email: [{ id: EMAIL }] },
        });
        return { policyId: policy.policyId, byIdName: byId.name };
      });
      const out = yield* stack.deploy(program);
      expect(out.byIdName).toBe(name);

      const live = yield* alerting.getPolicy({ accountId, policyId: out.policyId });
      expect(live.mechanisms?.webhooks?.map((w) => w.id)).toEqual([webhookId]);

      // A lookup re-resolves to the same webhook, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["webhook-lookup-policy"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the webhook alone.
      yield* stack.destroy();
      const survivor = yield* alerting.getDestinationWebhook({ accountId, webhookId });
      expect(survivor.name).toBe(name);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing webhook fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Alerting.NotificationPolicy("webhook-lookup-missing", {
            alertType: "universal_ssl_event_type",
            mechanisms: {
              webhooks: [
                { id: Cloudflare.Alerting.NotificationWebhook.lookup({ name }).webhookId },
              ],
            },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a webhook this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = Effect.gen(function* () {
        const receiver = yield* Cloudflare.Worker("lookup-managed-receiver", {
          main: pathe.resolve(import.meta.dirname, "fixtures/webhook-receiver.ts"),
          workersDev: true,
        });
        const webhook = yield* Cloudflare.Alerting.NotificationWebhook("lookup-managed", {
          url: receiver.url.as<string>(),
        });
        return { webhookId: webhook.webhookId };
      });
      const { webhookId } = yield* stack.deploy(managed);
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed;
            const webhook = Cloudflare.Alerting.NotificationWebhook.lookup({ webhookId });
            yield* Cloudflare.Alerting.NotificationPolicy("webhook-lookup-managed-policy", {
              alertType: "universal_ssl_event_type",
              mechanisms: { webhooks: [{ id: webhook.webhookId }] },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);
