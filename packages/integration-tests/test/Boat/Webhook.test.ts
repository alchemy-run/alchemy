import * as Boat from "@alchemy.run/boat";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Boat.providers() });

const tags = ["provider:boat", "provider:boat:webhook", "live"];

const observe = (webhookId: string) =>
  boat.getWebhook({ webhookId }).pipe(
    Effect.map((got): boat.Webhook | undefined => got.webhook),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

test.provider(
  "create a webhook, update its URL and events in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (url: string, events: Boat.WebhookEvent[]) =>
        Effect.gen(function* () {
          return yield* Boat.Webhook("Events", { url, events });
        });

      const hook = yield* stack.deploy(program("https://example.com/boat", ["sandbox.ready"]));
      expect(Redacted.value(hook.secret).length).toBeGreaterThan(0);
      const created = yield* observe(hook.webhookId);
      expect(created?.url).toBe("https://example.com/boat");
      expect(created?.events).toEqual(["sandbox.ready"]);

      const plan = yield* stack.plan(program("https://example.com/boat", ["sandbox.ready"]));
      expect(plan.resources.Events.action).toBe("noop");

      const updated = yield* stack.deploy(
        program("https://example.com/boat/v2", ["sandbox.ready", "sandbox.archived"]),
      );
      expect(updated.webhookId).toBe(hook.webhookId);
      expect(Redacted.value(updated.secret)).toBe(Redacted.value(hook.secret));
      const observed = yield* observe(hook.webhookId);
      expect(observed?.url).toBe("https://example.com/boat/v2");
      expect([...(observed?.events ?? [])].sort()).toEqual(["sandbox.archived", "sandbox.ready"]);

      yield* stack.destroy();
      expect(yield* observe(hook.webhookId)).toBeUndefined();
    }),
  { tags, timeout: 120_000 },
);
