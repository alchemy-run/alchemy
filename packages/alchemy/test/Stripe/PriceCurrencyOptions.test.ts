import {
  addedCurrencyOptions,
  currencyOptionsNeedReplace,
} from "@/Stripe/Price";
import { describe, expect, test } from "alchemy-test";

describe(
  "Stripe.Price currencyOptions",
  { tags: ["unit", "provider:stripe", "provider:stripe:price", "local"] },
  () => {
    test("adding a currency does not replace the price", () => {
      const observed = { eur: { unitAmount: 1400, unitAmountDecimal: "1400" } };
      const desired = {
        eur: { unitAmount: 1400 },
        gbp: { unitAmount: 1200 },
      };
      expect(currencyOptionsNeedReplace(desired, observed)).toBe(false);
      expect(addedCurrencyOptions(desired, observed)).toEqual({
        gbp: { unitAmount: 1200 },
      });
    });

    test("changing an existing amount replaces the price", () => {
      expect(
        currencyOptionsNeedReplace(
          { eur: { unitAmount: 1300 } },
          { eur: { unitAmount: 1400, unitAmountDecimal: "1400" } },
        ),
      ).toBe(true);
    });

    test("removing a currency replaces the price", () => {
      expect(
        currencyOptionsNeedReplace(
          { gbp: { unitAmount: 1200 } },
          { eur: { unitAmount: 1400 }, gbp: { unitAmount: 1200 } },
        ),
      ).toBe(true);
      expect(
        currencyOptionsNeedReplace({}, { eur: { unitAmount: 1400 } }),
      ).toBe(true);
    });
  },
);
