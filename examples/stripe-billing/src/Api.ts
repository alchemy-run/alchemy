import * as Cloudflare from "alchemy/Cloudflare";
import * as Stripe from "alchemy/Stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const product = yield* Stripe.Product("Pro", {
      name: "Pro",
      description: "Billed monthly",
    });
    const price = yield* Stripe.Price("ProMonthly", {
      product: product.id,
      currency: "usd",
      unitAmount: 2000,
      recurring: { interval: "month" },
    });
    const coupon = yield* Stripe.Coupon("Launch20", {
      percentOff: 20,
      duration: "once",
      name: "Launch 20%",
    });
    const checkout = yield* Stripe.PaymentLink("Checkout", {
      lineItems: [{ price: price.id, quantity: 1 }],
      allowPromotionCodes: true,
    });

    const retrieveProduct = yield* Stripe.RetrieveProduct(product);
    const retrievePrice = yield* Stripe.RetrievePrice(price);
    const retrieveCoupon = yield* Stripe.RetrieveCoupon(coupon);
    const retrieveCheckout = yield* Stripe.RetrievePaymentLink(checkout);
    const createCustomer = yield* Stripe.CreateCustomer();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (request.method === "GET" && url.pathname === "/") {
          const [liveProduct, livePrice, liveCoupon, liveCheckout] =
            yield* Effect.all(
              [
                retrieveProduct(),
                retrievePrice(),
                retrieveCoupon(),
                retrieveCheckout(),
              ],
              { concurrency: 4 },
            );
          return yield* HttpServerResponse.json({
            product: {
              id: liveProduct.id,
              name: liveProduct.name,
            },
            price: {
              id: livePrice.id,
              unitAmount: livePrice.unit_amount,
              currency: livePrice.currency,
            },
            coupon: {
              id: liveCoupon.id,
              percentOff: liveCoupon.percent_off,
            },
            paymentLink: {
              id: liveCheckout.id,
              url: liveCheckout.url,
            },
          });
        }

        if (request.method === "POST" && url.pathname === "/customers") {
          const body = (yield* request.json) as {
            email?: string;
            name?: string;
          };
          if (!body.email) {
            return yield* HttpServerResponse.json(
              { error: "email is required" },
              { status: 400 },
            );
          }
          const customer = yield* createCustomer({
            email: body.email,
            ...(body.name !== undefined ? { name: body.name } : {}),
          });
          return yield* HttpServerResponse.json(
            { id: customer.id, email: customer.email, name: customer.name },
            { status: 201 },
          );
        }

        if (request.method === "POST" && url.pathname === "/webhooks/stripe") {
          return HttpServerResponse.text("ok");
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stripe.CreateCustomerHttp,
        Stripe.RetrieveCouponHttp,
        Stripe.RetrievePaymentLinkHttp,
        Stripe.RetrievePriceHttp,
        Stripe.RetrieveProductHttp,
      ),
    ),
  ),
) {}
