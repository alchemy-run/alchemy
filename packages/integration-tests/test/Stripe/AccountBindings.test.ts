import * as Stripe from "@alchemy.run/stripe";
import { expect, it } from "@alchemy.run/test";
import { Credentials } from "@distilled.cloud/stripe";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/**
 * Account-scoped bindings for ids made at runtime (a promotion code a
 * customer typed, a returned checkout session, a tenant's customer). They
 * run hostless here, so each call goes through the ambient Credentials +
 * HttpClient; a fake HttpClient keeps every request.
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
    // The fake answers every call with a list body, so the typed decode of
    // a non-list response can fail: only the request matters.
    yield* Effect.exit(call(request) as Effect.Effect<unknown, unknown>);
  });

const cases = [
  {
    name: "ListPromotionCodes",
    method: "GET",
    path: "/v1/promotion_codes?active=true&code=SPRING&limit=1",
    body: "",
    run: Effect.gen(function* () {
      yield* callOnce(Stripe.ListPromotionCodes(), { code: "SPRING", active: true, limit: 1 });
    }).pipe(Effect.provide(Stripe.ListPromotionCodesHttp)),
  },
  {
    name: "RetrieveCheckoutSession",
    method: "GET",
    path: "/v1/checkout/sessions/cs_test_1",
    body: "",
    run: Effect.gen(function* () {
      yield* callOnce(Stripe.RetrieveCheckoutSession(), { session: "cs_test_1" });
    }).pipe(Effect.provide(Stripe.RetrieveCheckoutSessionHttp)),
  },
  {
    name: "UpdateCustomerById",
    method: "POST",
    path: "/v1/customers/cus_1",
    body: "invoice_settings%5Bdefault_payment_method%5D=pm_1",
    run: Effect.gen(function* () {
      yield* callOnce(Stripe.UpdateCustomerById(), {
        customer: "cus_1",
        invoice_settings: { default_payment_method: "pm_1" },
      });
    }).pipe(Effect.provide(Stripe.UpdateCustomerByIdHttp)),
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
        expect(request.url.split("?")[0]).toEqual(`https://api.stripe.test${c.path.split("?")[0]}`);
        for (const pair of (c.path.split("?")[1] ?? "").split("&").filter(Boolean)) {
          expect(request.url).toContain(pair);
        }
        expect(request.body).toContain(c.body);
      }),
    { tags: ["unit", "provider:stripe", "local"] },
  );
}
