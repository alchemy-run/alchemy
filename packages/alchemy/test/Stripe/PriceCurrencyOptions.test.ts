import { currencyOptionsEqual } from "@/Stripe/Price";
import { describe, expect, test } from "alchemy-test";

describe(
  "Stripe.Price currencyOptions",
  { tags: ["unit", "provider:stripe", "provider:stripe:price", "local"] },
  () => {
    test("ignores the unit_amount_decimal Stripe fills in", () => {
      expect(
        currencyOptionsEqual(
          { eur: { unitAmount: 1400 } },
          { eur: { unitAmount: 1400, unitAmountDecimal: "1400" } },
        ),
      ).toBe(true);
    });

    test("detects a changed amount", () => {
      expect(
        currencyOptionsEqual(
          { eur: { unitAmount: 1300 } },
          { eur: { unitAmount: 1400, unitAmountDecimal: "1400" } },
        ),
      ).toBe(false);
    });

    test("detects added and removed currencies", () => {
      expect(
        currencyOptionsEqual(
          { eur: { unitAmount: 1400 }, gbp: { unitAmount: 1200 } },
          { eur: { unitAmount: 1400 } },
        ),
      ).toBe(false);
      expect(currencyOptionsEqual({}, { eur: { unitAmount: 1400 } })).toBe(
        false,
      );
    });
  },
);
