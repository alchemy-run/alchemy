import * as Stripe from "@alchemy.run/stripe";
import { expect, it } from "@alchemy.run/test";
import { Credentials } from "@distilled.cloud/stripe";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/**
 * The billing bindings run hostless here (no Worker), so each call goes
 * through the ambient Credentials + HttpClient. A fake HttpClient keeps
 * every request it gets; the tests assert on the Stripe endpoint each
 * binding calls.
 */
interface SentRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

const fakeStripe = () => {
  const sent: SentRequest[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const body = request.body;
      sent.push({
        method: request.method,
        url: url.toString(),
        body:
          body._tag === "Uint8Array"
            ? new TextDecoder().decode(body.body)
            : body._tag === "Raw"
              ? String(body.body)
              : "",
      });
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ object: "list", data: [], has_more: false, url: "/" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  const layer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(
      Credentials,
      Effect.succeed({
        apiKey: Redacted.make("sk_test_fake"),
        apiBaseUrl: "https://api.stripe.test",
      }),
    ),
  );
  return { sent, layer };
};

const callOnce = <A>(
  binding: Effect.Effect<(request: A) => Effect.Effect<unknown, unknown, any>, unknown, any>,
  request: A,
) =>
  Effect.gen(function* () {
    const call = yield* binding;
    // The fake answers every call with the same body, so the typed
    // decode of a non-list response can fail: only the request matters.
    yield* Effect.exit(call(request) as Effect.Effect<unknown, unknown>);
  });

const cases = [
  {
    name: "CreateSubscription",
    method: "POST",
    path: "/v1/subscriptions",
    body: "customer=cus_1",
    run: Effect.gen(function* () {
      yield* callOnce(Stripe.CreateSubscription(), {
        customer: "cus_1",
        items: [{ price: "price_1" }],
      });
    }).pipe(Effect.provide(Stripe.CreateSubscriptionHttp)),
  },
  {
    name: "RetrieveSubscription",
    method: "GET",
    path: "/v1/subscriptions/sub_1",
    body: "",
    run: Effect.gen(function* () {
      yield* callOnce(Stripe.RetrieveSubscription(), {
        subscription_exposed_id: "sub_1",
      });
    }).pipe(Effect.provide(Stripe.RetrieveSubscriptionHttp)),
  },
  {
    name: "UpdateSubscription",
    method: "POST",
    path: "/v1/subscriptions/sub_1",
    body: "cancel_at_period_end=true",
    run: Effect.gen(function* () {
      yield* callOnce(Stripe.UpdateSubscription(), {
        subscription_exposed_id: "sub_1",
        cancel_at_period_end: true,
      });
    }).pipe(Effect.provide(Stripe.UpdateSubscriptionHttp)),
  },
  {
    name: "CreateSubscriptionItem",
    method: "POST",
    path: "/v1/subscription_items",
    body: "subscription=sub_1",
    run: Effect.gen(function* () {
      yield* callOnce(Stripe.CreateSubscriptionItem(), {
        subscription: "sub_1",
        price: "price_2",
      });
    }).pipe(Effect.provide(Stripe.CreateSubscriptionItemHttp)),
  },
  {
    name: "CreateInvoicePreview",
    method: "POST",
    path: "/v1/invoices/create_preview",
    body: "customer=cus_1",
    run: Effect.gen(function* () {
      yield* callOnce(Stripe.CreateInvoicePreview(), {
        customer: "cus_1",
        subscription: "sub_1",
      });
    }).pipe(Effect.provide(Stripe.CreateInvoicePreviewHttp)),
  },
  {
    name: "ListInvoices",
    method: "GET",
    path: "/v1/invoices?customer=cus_1",
    body: "",
    run: Effect.gen(function* () {
      yield* callOnce(Stripe.ListInvoices(), { customer: "cus_1" });
    }).pipe(Effect.provide(Stripe.ListInvoicesHttp)),
  },
  {
    name: "CreateInvoiceItem",
    method: "POST",
    path: "/v1/invoiceitems",
    body: "customer=cus_1",
    run: Effect.gen(function* () {
      yield* callOnce(Stripe.CreateInvoiceItem(), {
        customer: "cus_1",
        amount: 500,
        currency: "usd",
      });
    }).pipe(Effect.provide(Stripe.CreateInvoiceItemHttp)),
  },
  {
    name: "ListActiveEntitlements",
    method: "GET",
    path: "/v1/entitlements/active_entitlements?customer=cus_1",
    body: "",
    run: Effect.gen(function* () {
      yield* callOnce(Stripe.ListActiveEntitlements(), { customer: "cus_1" });
    }).pipe(Effect.provide(Stripe.ListActiveEntitlementsHttp)),
  },
  {
    name: "CreateBillingMeterEvent",
    method: "POST",
    path: "/v2/billing/meter_events",
    body: '"event_name":"api_requests"',
    run: Effect.gen(function* () {
      yield* callOnce(Stripe.CreateBillingMeterEvent(), {
        event_name: "api_requests",
        payload: { stripe_customer_id: "cus_1", value: "1" },
      });
    }).pipe(Effect.provide(Stripe.CreateBillingMeterEventHttp)),
  },
] as const;

for (const c of cases) {
  it.live(
    `${c.name} calls ${c.method} ${c.path.split("?")[0]}`,
    () =>
      Effect.gen(function* () {
        const { sent, layer } = fakeStripe();
        yield* c.run.pipe(Effect.provide(layer));
        expect(sent).toHaveLength(1);
        const [request] = sent;
        expect(request.method).toEqual(c.method);
        expect(request.url).toEqual(`https://api.stripe.test${c.path}`);
        expect(request.body).toContain(c.body);
      }),
    { tags: ["unit", "provider:stripe", "local"] },
  );
}
