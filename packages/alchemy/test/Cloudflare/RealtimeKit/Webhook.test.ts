import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as realtimeKit from "@distilled.cloud/cloudflare/realtime-kit";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// RealtimeKit is beta / entitlement-gated — unentitled accounts get the
// typed `Forbidden` (403) on every call. Probe and no-op when unentitled;
// the App suite pins the typed tag.
const probeEntitlement = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return yield* realtimeKit.getApp({ accountId }).pipe(
    Effect.as(true),
    Effect.catchTag("Forbidden", () => Effect.succeed(false)),
  );
});

const getWebhook = (accountId: string, appId: string, webhookId: string) =>
  realtimeKit.getWebhookByIdWebhook({ accountId, appId, webhookId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
    Effect.map((res) => res.data),
  );

// Poll until the webhook is gone after destroy — Cloudflare answers GET for
// a missing webhook with the typed `RealtimeKitWebhookNotFound` (404).
const expectGone = (accountId: string, appId: string, webhookId: string) =>
  getWebhook(accountId, appId, webhookId).pipe(
    Effect.asSome,
    Effect.catchTag("RealtimeKitWebhookNotFound", () => Effect.succeedNone),
    Effect.repeat({
      schedule: Schedule.exponential("500 millis"),
      until: Option.isNone,
      times: 8,
    }),
    Effect.map((webhook) => expect(Option.isNone(webhook)).toBe(true)),
  );

// Deterministic names — apps cannot be deleted, so every run adopts the
// same app instead of leaking a new one.
const APP_NAME = "alchemy-rtk-test-app";
const WEBHOOK_NAME = "alchemy-rtk-test-webhook";

test.provider(
  "create, verify out-of-band, update in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      const entitled = yield* probeEntitlement;
      if (!entitled) {
        yield* Effect.logInfo(
          "account is not RealtimeKit-entitled; skipping lifecycle",
        );
        return;
      }

      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Create — meeting lifecycle events to a fixed URL.
      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Cloudflare.RealtimeKitApp("App", {
            name: APP_NAME,
          });
          return yield* Cloudflare.RealtimeKitWebhook("Webhook", {
            appId: app.appId,
            name: WEBHOOK_NAME,
            url: "https://example.com/alchemy-rtk-webhook",
            events: ["meeting.started", "meeting.ended"],
          });
        }),
      );

      expect(v1.webhookId).toBeTruthy();
      expect(v1.accountId).toEqual(accountId);
      expect(v1.name).toEqual(WEBHOOK_NAME);
      expect(v1.url).toEqual("https://example.com/alchemy-rtk-webhook");
      expect([...v1.events].sort()).toEqual([
        "meeting.ended",
        "meeting.started",
      ]);
      expect(v1.enabled).toBe(true);

      // Out-of-band verification via the distilled API.
      const live = yield* getWebhook(accountId, v1.appId, v1.webhookId);
      expect(live.name).toEqual(WEBHOOK_NAME);
      expect(live.url).toEqual("https://example.com/alchemy-rtk-webhook");

      // In-place update — pause delivery and change the event set. Same
      // webhook (no replacement).
      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Cloudflare.RealtimeKitApp("App", {
            name: APP_NAME,
          });
          return yield* Cloudflare.RealtimeKitWebhook("Webhook", {
            appId: app.appId,
            name: WEBHOOK_NAME,
            url: "https://example.com/alchemy-rtk-webhook",
            events: ["recording.statusUpdate"],
            enabled: false,
          });
        }),
      );

      expect(v2.webhookId).toEqual(v1.webhookId);
      expect(v2.enabled).toBe(false);
      expect(v2.events).toEqual(["recording.statusUpdate"]);

      const updated = yield* getWebhook(accountId, v2.appId, v2.webhookId);
      expect(updated.enabled).toBe(false);
      expect([...updated.events]).toEqual(["recording.statusUpdate"]);

      // Idempotent re-deploy — reconcile must detect the no-op.
      const v3 = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Cloudflare.RealtimeKitApp("App", {
            name: APP_NAME,
          });
          return yield* Cloudflare.RealtimeKitWebhook("Webhook", {
            appId: app.appId,
            name: WEBHOOK_NAME,
            url: "https://example.com/alchemy-rtk-webhook",
            events: ["recording.statusUpdate"],
            enabled: false,
          });
        }),
      );
      expect(v3.webhookId).toEqual(v1.webhookId);

      // Destroy — the webhook must be deleted (the app remains; it has no
      // delete API).
      yield* stack.destroy();
      yield* expectGone(accountId, v1.appId, v1.webhookId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
