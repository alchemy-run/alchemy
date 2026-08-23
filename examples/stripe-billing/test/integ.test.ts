import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Stripe from "alchemy/Stripe";
import * as Test from "alchemy/Test/Bun";
import { DeleteCustomersCustomer } from "@distilled.cloud/stripe/stripe";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Stripe.providers()),
  state: Alchemy.localState(),
});

const { getWhenReady } = Test;

const stack = beforeAll(deploy(Stack), { timeout: 180_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 120_000,
});

test(
  "deploys a worker URL and webhook endpoint",
  Effect.gen(function* () {
    const { url, webhookId } = yield* stack;
    expect(url).toBeString();
    expect(webhookId).toMatch(/^we_/);
  }),
);

test(
  "catalog bindings retrieve the product, price, coupon, and payment link",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* getWhenReady(url.replace(/\/+$/, ""));
    expect(response.status).toBe(200);
    const body = (yield* response.json) as {
      product: { id: string; name: string };
      price: { id: string; unitAmount: number; currency: string };
      coupon: { id: string; percentOff: number };
      paymentLink: { id: string; url: string };
    };
    expect(body.product.id).toMatch(/^prod_/);
    expect(body.product.name).toEqual("Pro");
    expect(body.price.id).toMatch(/^price_/);
    expect(body.price.unitAmount).toEqual(2000);
    expect(body.price.currency).toEqual("usd");
    expect(body.coupon.percentOff).toEqual(20);
    expect(body.paymentLink.url).toMatch(/^https:\/\//);
  }),
  { timeout: 120_000 },
);

test(
  "CreateCustomer binding creates a Stripe customer",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const baseUrl = url.replace(/\/+$/, "");
    yield* getWhenReady(baseUrl);

    const created = yield* HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}/customers`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          email: "stripe-billing-example@example.com",
          name: "Example Customer",
        }),
      ),
    );
    expect(created.status).toBe(201);
    const body = (yield* created.json) as {
      id: string;
      email: string;
      name: string;
    };
    expect(body.id).toMatch(/^cus_/);
    expect(body.email).toEqual("stripe-billing-example@example.com");
    expect(body.name).toEqual("Example Customer");

    yield* DeleteCustomersCustomer({ customer: body.id }).pipe(
      Effect.catch(() => Effect.void),
    );
  }),
  { timeout: 120_000 },
);
