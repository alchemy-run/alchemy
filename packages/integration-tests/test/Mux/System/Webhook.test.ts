import * as Mux from "@alchemy.run/mux";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as System from "@distilled.cloud/mux/system";
import * as Drift from "alchemy/Drift";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Mux.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const ADDRESS = "https://alchemy-test.example.com/mux/webhook";
const MOVED = "https://alchemy-test.example.com/mux/webhook-moved";
const TAKEN = "https://alchemy-test.example.com/mux/webhook-taken";

const waitUntilGone = (id: string) =>
  System.getWebhook({ WEBHOOK_ID: id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update in place, and delete a webhook",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(Mux.System.Webhook("Events", { address: ADDRESS }));
      expect(created.address).toEqual(ADDRESS);
      expect(created.enabled).toEqual(true);
      expect(Redacted.value(created.signing_secret).length).toBeGreaterThanOrEqual(16);

      const { data: live } = yield* System.getWebhook({ WEBHOOK_ID: created.id });
      expect(live.address).toEqual(ADDRESS);

      const updated = yield* stack.deploy(
        Mux.System.Webhook("Events", { address: MOVED, enabled: false }),
      );
      expect(updated.id).toEqual(created.id);
      expect(Redacted.value(updated.signing_secret)).toEqual(
        Redacted.value(created.signing_secret),
      );
      const { data: moved } = yield* System.getWebhook({ WEBHOOK_ID: created.id });
      expect(moved.address).toEqual(MOVED);
      expect(moved.enabled).toEqual(false);

      const provider = yield* Provider.findProvider(Mux.System.Webhook);
      const found = yield* provider.lookup!({ address: MOVED });
      expect(found?.id).toEqual(created.id);
      const listed = yield* provider.list!();
      expect(listed.map((hook) => hook.id)).toContain(created.id);

      yield* stack.destroy();
      expect(yield* waitUntilGone(created.id)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:webhook", "live"], timeout: 120_000 },
);

test.provider(
  "drift repair recreates a webhook deleted outside Alchemy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(Mux.System.Webhook("Events", { address: ADDRESS }));
      yield* System.deleteWebhook({ WEBHOOK_ID: first.id });

      const drift = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect(drift.resources.Events?.action).toBe("missing");
      yield* Drift.repair(stack).pipe(Effect.provide(stack.state));

      const second = yield* stack.deploy(Mux.System.Webhook("Events", { address: ADDRESS }));
      expect(second.id).not.toEqual(first.id);
      const { data: live } = yield* System.getWebhook({ WEBHOOK_ID: second.id });
      expect(live.address).toEqual(ADDRESS);

      yield* stack.destroy();
      expect(yield* waitUntilGone(second.id)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:webhook", "live"], timeout: 120_000 },
);

test.provider(
  "a second webhook for an address already in use fails with WebhookAddressInUse",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { data: existing } = yield* System.createWebhook({ address: TAKEN });
      const error = yield* stack
        .deploy(Mux.System.Webhook("Events", { address: TAKEN }))
        .pipe(
          Effect.flip,
          Effect.ensuring(System.deleteWebhook({ WEBHOOK_ID: existing.id }).pipe(Effect.ignore)),
        );
      expect(JSON.stringify(error)).toContain("WebhookAddressInUse");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:webhook", "live"], timeout: 120_000 },
);
