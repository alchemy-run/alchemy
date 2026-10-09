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
    const worker = yield* BankWorker;
    return { url: worker.url.as<string>() };
  }),
);
