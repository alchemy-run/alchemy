import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Stripe from "alchemy/Stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import BankWorker from "./src/BankWorker.ts";

export default Alchemy.Stack(
  "CloudflareFoldExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Stripe.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const bank = yield* BankWorker;
    // The foldkit app, built with Vite and served as static assets. A
    // `VITE_`-prefixed env value is inlined into the client bundle.
    const app = yield* Cloudflare.Website.Foldkit("BankApp", {
      env: { VITE_BANK_URL: bank.url.as<string>() },
    });
    return { url: bank.url.as<string>(), app: app.url.as<string>() };
  }),
);
