import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Slack from "@alchemy.run/slack";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Apps from "@distilled.cloud/slack/apps";
import * as Alchemy from "alchemy";
import { isRedactedMarker } from "alchemy/RuntimeContext";
import { isResourceState, State } from "alchemy/State";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import SlackEventsWorker from "./fixtures/events-worker.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), Slack.providers());
const { test } = Test.make({ providers });

const tags = [
  "provider:cloudflare",
  "provider:cloudflare:worker",
  "provider:slack",
  "provider:slack:events",
  "live",
];

class AppRowMissing extends Data.TaggedError("AppRowMissing")<{ message: string }> {}

const reveal = (value: unknown): string | undefined =>
  Redacted.isRedacted(value)
    ? (Redacted.value(value) as string)
    : isRedactedMarker(value)
      ? (value.value as string)
      : typeof value === "string"
        ? value
        : undefined;

/** Sign a body the way Slack does (`v0=` HMAC-SHA256 of `v0:{ts}:{body}`). */
const sign = (secret: string, timestamp: number, body: string) =>
  Effect.tryPromise(async () => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`));
    return `v0=${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  });

const post = (url: string, body: string, headers: Record<string, string>) =>
  HttpClient.execute(
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({ "content-type": "application/json", ...headers }),
      HttpClientRequest.bodyText(body, "application/json"),
    ),
  );

test.provider(
  "consumeEvents creates the app pointed at the Worker and handles a signed delivery",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* SlackEventsWorker;
          return { url: worker.url.as<string>() };
        }),
      );
      const base = url.replace(/\/+$/, "");
      const eventsUrl = `${base}/slack/events`;
      yield* Test.getWhenReady(`${base}/`);

      // The app the event source created, from this stack's state.
      const state = yield* yield* State;
      const fqns = yield* state.list({ stack: stack.name, stage: stack.stage });
      const rows = yield* Effect.forEach(fqns, (fqn) =>
        state.get({ stack: stack.name, stage: stack.stage, fqn }),
      );
      const app = rows.find((row) => isResourceState(row) && row.resourceType === "Slack.App");
      if (app === undefined || !isResourceState(app) || app.attr === undefined) {
        return yield* new AppRowMissing({ message: "no Slack.App row after deploy" });
      }
      const appId = (app.attr as { appId: string }).appId;
      const secret = reveal((app.attr as { signingSecret?: unknown }).signingSecret);
      expect(secret).toBeTruthy();

      // Out of band: Slack has the Worker as the app's Events API URL.
      const { manifest } = yield* Slack.withAppConfigToken(Apps.exportManifest({ app_id: appId }));
      const settings = (manifest as Slack.AppManifest).settings;
      expect(settings?.event_subscriptions?.request_url).toBe(eventsUrl);
      expect(settings?.event_subscriptions?.bot_events).toEqual(["app_mention"]);

      // Unsigned and badly signed deliveries are refused.
      const now = Math.floor(Date.now() / 1000);
      const eventId = `Ev${stack.stage.replaceAll(/[^A-Za-z0-9]/g, "")}${now}`;
      const body = JSON.stringify({
        type: "event_callback",
        event_id: eventId,
        event_time: now,
        team_id: "T0000000000",
        api_app_id: appId,
        event: {
          type: "app_mention",
          user: "U0000000000",
          text: "<@U0000000000> hello",
          ts: `${now}.000100`,
          channel: "C0000000000",
          event_ts: `${now}.000100`,
        },
      });
      const unsigned = yield* post(eventsUrl, body, {});
      expect(unsigned.status).toBe(401);
      const forged = yield* post(eventsUrl, body, {
        "x-slack-request-timestamp": String(now),
        "x-slack-signature": "v0=00",
      });
      expect(forged.status).toBe(401);
      const stale = yield* post(eventsUrl, body, {
        "x-slack-request-timestamp": String(now - 600),
        "x-slack-signature": yield* sign(secret!, now - 600, body),
      });
      expect(stale.status).toBe(401);

      // The URL challenge is answered once signed.
      const challengeBody = JSON.stringify({ type: "url_verification", challenge: "abc123" });
      const challenge = yield* post(eventsUrl, challengeBody, {
        "x-slack-request-timestamp": String(now),
        "x-slack-signature": yield* sign(secret!, now, challengeBody),
      });
      expect(challenge.status).toBe(200);
      expect(yield* challenge.json).toEqual({ challenge: "abc123" });

      // A signed delivery reaches the handler.
      const delivered = yield* post(eventsUrl, body, {
        "x-slack-request-timestamp": String(now),
        "x-slack-signature": yield* sign(secret!, now, body),
      });
      expect(delivered.status).toBe(200);
      const seen = yield* Effect.gen(function* () {
        const response = yield* HttpClient.get(`${base}/seen/${eventId}`);
        return ((yield* response.json) as { seen: { type: string; text: string } | null }).seen;
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (s) => s !== null,
          times: 15,
        }),
      );
      expect(seen).toEqual({ type: "app_mention", text: "<@U0000000000> hello" });

      yield* stack.destroy();
      const gone = yield* Slack.withAppConfigToken(
        Apps.exportManifest({ app_id: appId }).pipe(
          Effect.as(false),
          Effect.catchTag(["AppNotFound", "InvalidAppId"], () => Effect.succeed(true)),
        ),
      );
      expect(gone).toBe(true);
    }),
  { tags, timeout: 240_000 },
);
