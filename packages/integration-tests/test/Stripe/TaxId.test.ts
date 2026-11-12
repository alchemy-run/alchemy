import { createHash } from "node:crypto";
import * as Stripe from "@alchemy.run/stripe";
import { isMissingStripeResource } from "@alchemy.run/stripe/missing";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { GetTaxIdsById } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (id: string) =>
  GetTaxIdsById({ id }).pipe(
    Effect.map((taxId) => ("deleted" in taxId ? ("gone" as const) : ("found" as const))),
    Effect.catchIf(isMissingStripeResource, () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

/** Account tax ids are shared by every stage, so each stage gets its own EIN. */
const einFor = (stage: string, suffix: string) =>
  Effect.sync(() => {
    const digits = BigInt(`0x${createHash("sha256").update(`${stage}:${suffix}`).digest("hex")}`)
      .toString()
      .slice(0, 9);
    return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  });

test.provider(
  "create an account tax id and replace it when the value changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* einFor(stack.stage, "a");
      const second = yield* einFor(stack.stage, "b");

      const deploy = (value: string) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Stripe.TaxId("BusinessEin", { type: "us_ein", value });
          }),
        );

      const created = yield* deploy(first);
      yield* expectFound(Stripe.TaxId.lookup({ id: created.id }), created);
      expect(created.id).toMatch(/^txi_/);
      expect(created.type).toEqual("us_ein");
      expect(created.value).toEqual(first);
      expect(created.owner).toEqual({ type: "self" });

      const fetched = yield* GetTaxIdsById({ id: created.id });
      expect(fetched.value).toEqual(first);
      expect(fetched.owner?.type).toEqual("self");

      const unchanged = yield* deploy(first);
      expect(unchanged.id).toEqual(created.id);

      const replaced = yield* deploy(second);
      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.value).toEqual(second);
      expect(yield* waitUntilGone(created.id)).toEqual("gone");

      yield* stack.destroy();

      expect(yield* waitUntilGone(replaced.id)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:stripe", "provider:stripe:taxid", "live"],
    timeout: 120_000,
  },
);
