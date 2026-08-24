import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Stripe from "alchemy/Stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "StripeBillingExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Stripe.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    const webhook = yield* Stripe.WebhookEndpoint("Events", {
      url: Output.interpolate`${api.url}/webhooks/stripe`,
      enabledEvents: ["customer.created", "checkout.session.completed"],
    });

    return {
      url: api.url.as<string>(),
      webhookId: webhook.id,
    };
  }),
);
