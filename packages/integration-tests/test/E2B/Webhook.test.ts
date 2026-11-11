import * as E2B from "@alchemy.run/e2b";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as webhooks from "@distilled.cloud/e2b/webhooks";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: E2B.providers() });

const expectWebhookGone = (webhookId: string) =>
  webhooks.getWebhook({ webhookID: webhookId }).pipe(
    Effect.map(() => true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
    Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (exists) => !exists, times: 10 }),
    Effect.map((exists) => expect(exists).toBe(false)),
  );

test.provider(
  "create, update events and url, disable, and delete a webhook",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const secret = Redacted.make("alchemy-webhook-test-signature-secret");

      const hook = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Webhook("Lifecycle", {
            url: "https://example.com/e2b/one",
            signatureSecret: secret,
          });
        }),
      );
      expect(hook.events.sort()).toEqual([...E2B.ALL_SANDBOX_EVENTS].sort());
      expect(hook.enabled).toBe(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* E2B.Webhook("Lifecycle", {
            url: "https://example.com/e2b/two",
            events: ["sandbox.lifecycle.killed"],
            enabled: false,
            signatureSecret: secret,
          });
        }),
      );
      expect(updated.webhookId).toBe(hook.webhookId);
      const observed = yield* webhooks.getWebhook({ webhookID: hook.webhookId });
      expect(observed.url).toBe("https://example.com/e2b/two");
      expect(observed.events).toEqual(["sandbox.lifecycle.killed"]);
      expect(observed.enabled).toBe(false);

      yield* stack.destroy();
      yield* expectWebhookGone(hook.webhookId);
    }),
  { tags: ["provider:e2b", "provider:e2b:webhook", "live"], timeout: 120_000 },
);
