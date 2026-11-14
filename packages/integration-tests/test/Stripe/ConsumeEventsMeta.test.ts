import * as Stripe from "@alchemy.run/stripe";
import { expect, it } from "@alchemy.run/test";
import * as Output from "alchemy/Output";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { WebhookHost } from "alchemy/WebhookHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/**
 * `consumeEvents` hands the handler the event's envelope (`meta`) beside
 * its object, so a handler can log and deduplicate by event id. The host
 * here is a fake: it keeps the claimed route, and its RuntimeContext
 * answers the signing secret.
 */
const SECRET = "whsec_test_meta";

const sign = async (payload: string) => {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  return `t=${t},v1=${Buffer.from(mac).toString("hex")}`;
};

const fakeHost = () => {
  const routes = new Map<string, (request: Request) => Effect.Effect<Response>>();
  const host = Layer.succeed(WebhookHost, {
    LogicalId: "Api",
    url: Output.literal("https://api.example.com"),
    bind: () => Effect.void,
    route: (path, handler) =>
      Effect.sync(() => {
        routes.set(path, handler as (request: Request) => Effect.Effect<Response>);
      }),
  });
  const runtime = Layer.succeed(RuntimeContext, {
    Type: "Test.Host",
    id: "Api",
    env: {},
    get: <T>(key: string) =>
      Effect.succeed(
        (key === Stripe.webhookSecretEnvName() ? Redacted.make(SECRET) : undefined) as T,
      ),
    set: (id: string) => Effect.succeed(id),
  } as never);
  return { routes, layer: Layer.mergeAll(host, runtime) };
};

it.live(
  "the handler gets the event id, created time and mode",
  () =>
    Effect.gen(function* () {
      const { routes, layer } = fakeHost();
      const seen: Stripe.CustomerCreated[] = [];
      const previous = globalThis.__ALCHEMY_RUNTIME__;
      globalThis.__ALCHEMY_RUNTIME__ = true;
      yield* Stripe.consumeEvents({ events: [Stripe.CustomerCreated] }, (event) =>
        Effect.sync(() => {
          seen.push(event);
        }),
      ).pipe(
        Effect.provide(Stripe.ConsumeEventsLive.pipe(Layer.provide(layer))),
        Effect.provide(layer),
        Effect.ensuring(Effect.sync(() => (globalThis.__ALCHEMY_RUNTIME__ = previous))),
      );

      const payload = JSON.stringify({
        id: "evt_123",
        object: "event",
        type: "customer.created",
        created: 1_700_000_000,
        livemode: false,
        api_version: "2026-05-27.dahlia",
        data: { object: { id: "cus_9", object: "customer" } },
      });
      const signature = yield* Effect.promise(() => sign(payload));
      const handler = routes.get("/webhooks/stripe")!;
      const response = yield* handler(
        new Request("https://api.example.com/webhooks/stripe", {
          method: "POST",
          body: payload,
          headers: { "stripe-signature": signature },
        }),
      );

      expect(response.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.object.id).toBe("cus_9");
      expect(seen[0]!.meta).toEqual({
        id: "evt_123",
        created: 1_700_000_000,
        livemode: false,
        apiVersion: "2026-05-27.dahlia",
      });
    }),
  { tags: ["unit", "provider:stripe", "local"] },
);
