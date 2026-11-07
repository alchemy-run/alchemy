import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { WebhookHost } from "alchemy/WebhookHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  type SandboxEvent,
  SandboxEvents,
  type SandboxEventsProps,
  type SandboxEventsService,
  sandboxEventsPath,
  sandboxEventsSecretEnvName,
} from "./SandboxEvents.ts";
import { ALL_SANDBOX_EVENTS, Webhook } from "./Webhook.ts";

/**
 * {@link SandboxEvents} on any {@link WebhookHost}: every Cloudflare Worker
 * is one.
 *
 * @layer
 * @product Webhook
 * @provides E2B.SandboxEvents
 */
export const SandboxEventsLive = Layer.effect(
  SandboxEvents,
  Effect.gen(function* () {
    const host = yield* WebhookHost;
    // Yielding the resource class erases its `Providers` requirement; the
    // stack satisfies it at plan time.
    const createWebhook = yield* Webhook;

    return Effect.fn(function* (
      props: SandboxEventsProps,
      process: (event: SandboxEvent) => Effect.Effect<void, never, any>,
    ) {
      const path = sandboxEventsPath(props);
      const secret =
        props.secret ??
        (yield* Namespace.push(host.LogicalId, Random(`E2BEventsSecret${path}`))).text;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.asVoid(
            createWebhook(`E2BEvents${path}`, {
              url: Output.interpolate`${host.url}${path}`,
              events: [...(props.events ?? ALL_SANDBOX_EVENTS)],
              signatureSecret: secret,
            }),
          ),
        );
      }

      // Registers the secret on the host at deploy, reads it back at runtime.
      const boundSecret = yield* Output.named(
        Output.asOutput(secret) as Output.Output<Redacted.Redacted<string>, never>,
        sandboxEventsSecretEnvName(path),
      ).asEffect();

      yield* host.route(path, (request) => handleDelivery(request, boundSecret, process));
    }) as SandboxEventsService;
  }),
);

const handleDelivery = <Req>(
  request: Request,
  secret: Effect.Effect<Redacted.Redacted<string> | undefined>,
  process: (event: SandboxEvent) => Effect.Effect<void, never, Req>,
): Effect.Effect<Response, never, Req> =>
  Effect.gen(function* () {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const body = yield* Effect.tryPromise(() => request.text()).pipe(Effect.option);
    if (body._tag === "None") return new Response("unreadable body", { status: 400 });
    const resolved = yield* secret;
    const valid = yield* verifySignature(
      resolved === undefined ? undefined : Redacted.value(resolved),
      body.value,
      request.headers.get("e2b-signature") ?? undefined,
    );
    if (!valid) return new Response("invalid signature", { status: 401 });
    const event = yield* Effect.try(() => JSON.parse(body.value) as SandboxEvent).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (event === undefined) return new Response("invalid payload", { status: 400 });
    yield* process(event);
    return new Response(null, { status: 202 });
  });

/**
 * E2B's signature: the unpadded base64 SHA-256 of the secret followed by the
 * raw body (a plain hash, not an HMAC).
 */
const verifySignature = (
  secret: string | undefined,
  body: string,
  signature: string | undefined,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!secret || !signature) return false;
    const digest = yield* Effect.tryPromise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret + body)),
    ).pipe(Effect.option);
    if (digest._tag === "None") return false;
    let binary = "";
    for (const byte of new Uint8Array(digest.value)) binary += String.fromCharCode(byte);
    const expected = btoa(binary).replace(/=+$/, "");
    return timingSafeEqual(expected, signature);
  });

/** Constant-time comparison; `crypto.timingSafeEqual` needs `nodejs_compat` on Workers. */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
};
