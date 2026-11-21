import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { isRedactedMarker, RuntimeContext } from "alchemy/RuntimeContext";
import { WebhookHost } from "alchemy/WebhookHost";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { App, type AppManifest } from "./App.ts";
import {
  EventSource,
  eventsPath,
  signingSecretEnvName,
  type ConsumeEventsProps,
  type EventCallback,
  type EventSourceService,
  type EventSubscription,
} from "./ConsumeEvents.ts";

/** Slack rejects deliveries signed more than five minutes ago; so do we. */
const MAX_SKEW_SECONDS = 5 * 60;

/**
 * {@link consumeEvents} on any {@link WebhookHost}.
 *
 * Deploy-time: creates the {@link App} with its Events API URL pointing at
 * the host and binds the app's signing secret into the host. Under `alchemy
 * dev` the host is on localhost, which Slack can't reach, so no app is
 * created. Runtime: claims requests on the path, answers Slack's
 * `url_verification` challenge, verifies `X-Slack-Signature`, and runs the
 * handler once per delivery.
 *
 * Every Cloudflare Worker is a {@link WebhookHost}, so this is the only layer
 * to provide.
 *
 * @layer
 * @product Events
 * @provides Slack.EventSource
 */
export const ConsumeEventsLive = Layer.effect(
  EventSource,
  Effect.gen(function* () {
    const host = yield* WebhookHost;
    // Yielding the class erases its `Slack.Providers` requirement; the stack
    // provides it at plan time.
    const createApp = yield* App;

    return Effect.fn(function* (
      id: string,
      props: ConsumeEventsProps<readonly EventSubscription[]>,
      process: (delivery: EventCallback) => Effect.Effect<void, never, never>,
    ) {
      const runtime = yield* RuntimeContext;
      const path = eventsPath(props.path);

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            const context = yield* Effect.serviceOption(AlchemyContext);
            if (Option.isSome(context) && context.value.dev) {
              yield* Effect.logWarning(
                `Slack.consumeEvents: no app for ${path} under alchemy dev; Slack only delivers to public URLs, so deploy to receive events.`,
              );
              return;
            }
            const app = yield* createApp(id, {
              manifest: withEventSubscriptions(
                props.manifest,
                Output.interpolate`${host.url}${path}`,
                props.events,
              ),
            });
            // A binding, not a prop: the app depends on the host's URL.
            yield* host.bind(`slack-events:${path}`, {
              env: { [signingSecretEnvName(props.path)]: app.signingSecret },
            });
          }),
        );
      }

      const secret = runtime.get<unknown>(signingSecretEnvName(props.path));
      yield* host.route(path, (request) => handleDelivery(request, secret, process));
    }) as EventSourceService;
  }),
);

const withEventSubscriptions = (
  manifest: AppManifest,
  requestUrl: Output.Output<string>,
  events: readonly string[],
) => ({
  ...manifest,
  settings: {
    ...manifest.settings,
    event_subscriptions: {
      ...manifest.settings?.event_subscriptions,
      request_url: requestUrl,
      bot_events: [...events],
    },
  },
});

const asSecret = (raw: unknown): string | undefined => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (Redacted.isRedacted(raw)) {
    const value = Redacted.value(raw);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
  if (isRedactedMarker(raw) && typeof raw.value === "string") {
    return raw.value.length > 0 ? raw.value : undefined;
  }
  return typeof raw === "string" ? raw : undefined;
};

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Constant-time compare (`timingSafeEqual` needs `nodejs_compat` on Workers). */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * Verify Slack's v0 request signature: `v0=` + hex HMAC-SHA256 of
 * `v0:{timestamp}:{body}` with the app's signing secret.
 * @see https://docs.slack.dev/authentication/verifying-requests-from-slack
 */
export const verifySlackSignature = (options: {
  readonly secret: string;
  readonly body: string;
  readonly timestamp: string | null;
  readonly signature: string | null;
  readonly nowSeconds: number;
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const { secret, body, timestamp, signature, nowSeconds } = options;
    if (timestamp === null || signature === null || !signature.startsWith("v0=")) return false;
    const sent = Number(timestamp);
    if (!Number.isFinite(sent) || Math.abs(nowSeconds - sent) > MAX_SKEW_SECONDS) return false;
    const expected = yield* Effect.tryPromise(async () => {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return `v0=${hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`)))}`;
    }).pipe(Effect.orElseSucceed(() => undefined));
    return expected !== undefined && timingSafeEqual(expected, signature);
  });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const handleDelivery = (
  request: Request,
  secret: Effect.Effect<unknown>,
  process: (delivery: EventCallback) => Effect.Effect<void, never, never>,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const body = yield* Effect.tryPromise(() => request.text()).pipe(
      Effect.orElseSucceed(() => ""),
    );
    const parsed = yield* Effect.try(() => JSON.parse(body) as Record<string, unknown>).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
      return new Response("bad request", { status: 400 });
    }

    const signingSecret = asSecret(yield* secret);
    if (signingSecret === undefined) {
      // The app is created after the host (its URL points here), and Slack
      // checks the URL before the signing secret is bound. Answer the
      // challenge (an echo, so nothing leaks); refuse everything else.
      if (parsed.type === "url_verification" && typeof parsed.challenge === "string") {
        return json({ challenge: parsed.challenge });
      }
      return new Response("signing secret missing", { status: 500 });
    }

    const valid = yield* verifySlackSignature({
      secret: signingSecret,
      body,
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature"),
      nowSeconds: Math.floor((yield* Clock.currentTimeMillis) / 1000),
    });
    if (!valid) {
      return new Response("invalid signature", { status: 401 });
    }

    if (parsed.type === "url_verification" && typeof parsed.challenge === "string") {
      return json({ challenge: parsed.challenge });
    }
    if (parsed.type === "event_callback") {
      // The JSON came from Slack (the signature says so) and is shaped as
      // documented; the handler narrows `event` by its `type`.
      yield* process(parsed as unknown as EventCallback);
    }
    return new Response(null, { status: 200 });
  });
