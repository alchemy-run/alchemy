import * as Stripe from "@alchemy.run/stripe";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { withRequestOptions } from "@distilled.cloud/stripe";
import { GetProductCatalogTrialOffer } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const getOffer = (id: string) =>
  GetProductCatalogTrialOffer({ id }).pipe(withRequestOptions({ apiVersion: "2026-10-28.endive" }));

test.provider(
  "create, deactivate, and replace a trial offer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (props: { iterations: number; active?: boolean }) =>
        stack.deploy(
          Effect.gen(function* () {
            const product = yield* Stripe.Product("TrialProduct", {
              name: "Alchemy Trial Offer Product",
            });
            const intro = yield* Stripe.Price("IntroPrice", {
              product,
              currency: "usd",
              unitAmount: 100,
              recurring: { interval: "month" },
            });
            const monthly = yield* Stripe.Price("MonthlyPrice", {
              product,
              currency: "usd",
              unitAmount: 1000,
              recurring: { interval: "month" },
            });
            const offer = yield* Stripe.TrialOffer("IntroOffer", {
              price: intro,
              duration: { iterations: props.iterations },
              endBehavior: { transition: { price: monthly } },
              nickname: "Intro month",
              ...(props.active !== undefined ? { active: props.active } : {}),
            });
            return { offer, intro, monthly };
          }),
        );

      const created = yield* deploy({ iterations: 1 });
      yield* expectFound(Stripe.TrialOffer.lookup({ id: created.offer.id }), created.offer);
      expect(created.offer.id).toMatch(/^to_/);
      expect(created.offer.price).toEqual(created.intro.id);
      expect(created.offer.duration).toEqual({ iterations: 1 });
      expect(created.offer.endBehavior).toEqual({ transition: { price: created.monthly.id } });
      expect(created.offer.nickname).toEqual("Intro month");
      expect(created.offer.active).toEqual(true);

      const fetched = yield* getOffer(created.offer.id);
      expect(fetched.duration.relative?.iterations).toEqual(1);

      const paused = yield* deploy({ iterations: 1, active: false });
      expect(paused.offer.id).toEqual(created.offer.id);
      expect(paused.offer.active).toEqual(false);
      expect((yield* getOffer(created.offer.id)).active).toEqual(false);

      const replaced = yield* deploy({ iterations: 3 });
      expect(replaced.offer.id).not.toEqual(created.offer.id);
      expect(replaced.offer.duration).toEqual({ iterations: 3 });

      yield* stack.destroy();

      expect((yield* getOffer(replaced.offer.id)).active).toEqual(false);
    }).pipe(logLevel),
  {
    tags: ["provider:stripe", "provider:stripe:trialoffer", "live"],
    timeout: 120_000,
  },
);
