import {
  CUSTOM_HOSTNAME_FREE_INCLUDED,
  CUSTOM_HOSTNAME_USD_PER_MONTH,
  CustomHostnamePricing,
} from "@/Cloudflare/CustomHostname/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

const PAYG_LABEL = "Cloudflare for SaaS custom hostname";
const ENTERPRISE_LABEL =
  "Cloudflare for SaaS custom hostname (Enterprise-only options configured — Enterprise pricing is custom-quoted; pay-as-you-go rate shown)";
const UNRESOLVED_LABEL =
  "Cloudflare for SaaS custom hostname (Enterprise options unresolved at plan time — pay-as-you-go rates shown)";

describe("CustomHostnamePricing", () => {
  describe("floor — the first 100 hostnames are free", () => {
    test("floors to $0 regardless of props", () => {
      expect(CustomHostnamePricing.floorMonthlyUsd(undefined)).toBe(0);
      expect(CustomHostnamePricing.floorMonthlyUsd({} as never)).toBe(0);
      expect(
        CustomHostnamePricing.floorMonthlyUsd({
          zoneId: "zone-id",
          hostname: "app.customer.com",
        }),
      ).toBe(0);
    });
  });

  describe("requiresPaidPlan", () => {
    test("Cloudflare for SaaS runs on the Free plan", () => {
      expect(CustomHostnamePricing.requiresPaidPlan).toBe(false);
    });
  });

  describe("rates", () => {
    test("exposes $0.10 per hostname-month with the 100 free allotment", () => {
      expect(CUSTOM_HOSTNAME_USD_PER_MONTH).toBe(0.1);
      expect(CUSTOM_HOSTNAME_FREE_INCLUDED).toBe(100);

      const rates = CustomHostnamePricing.rates({
        zoneId: "zone-id",
        hostname: "app.customer.com",
      });
      expect(rates).toHaveLength(1);
      expect(rates[0].label).toBe(PAYG_LABEL);
      expect(rates[0].perUnit).toBe(0.1);
      expect(rates[0].unit).toBe("hostname-month");
      expect(rates[0].freeIncluded).toBe(
        "100 hostnames free (Free/Pro/Business)",
      );
    });

    test("absent props read as the plain pay-as-you-go rate", () => {
      expect(CustomHostnamePricing.rates(undefined)[0].label).toBe(PAYG_LABEL);
      expect(CustomHostnamePricing.rates({} as never)[0].label).toBe(
        PAYG_LABEL,
      );
    });

    test("non-Enterprise props do not flip the label", () => {
      const rates = CustomHostnamePricing.rates({
        zoneId: "zone-id",
        hostname: "app.customer.com",
        ssl: { method: "txt", type: "dv" },
      });
      expect(rates[0].label).toBe(PAYG_LABEL);
    });

    // The plans page lists "Custom origin" as available on Free, Pro,
    // Business and Enterprise — only the SNI rewrite is Enterprise-only.
    test("a custom origin server alone does not imply Enterprise", () => {
      const rates = CustomHostnamePricing.rates({
        zoneId: "zone-id",
        hostname: "app.customer.com",
        customOriginServer: "origin.example.com",
      });
      expect(rates[0].label).toBe(PAYG_LABEL);
      expect(rates[0].perUnit).toBe(0.1);
    });
  });

  describe("Enterprise entitlement branch", () => {
    test("customOriginSni marks the zone as Enterprise-quoted", () => {
      // Still reports the published PAYG rate — the label, not a bogus
      // number, is what communicates "custom-quoted".
      expect(
        CustomHostnamePricing.rates({
          zoneId: "zone-id",
          hostname: "app.customer.com",
          customOriginSni: ":request_host_header:",
        })[0].perUnit,
      ).toBe(0.1);
      expect(
        CustomHostnamePricing.rates({
          zoneId: "zone-id",
          hostname: "app.customer.com",
          customOriginSni: ":request_host_header:",
        })[0].label,
      ).toBe(ENTERPRISE_LABEL);
    });

    test("customMetadata marks the zone as Enterprise-quoted", () => {
      expect(
        CustomHostnamePricing.rates({
          zoneId: "zone-id",
          hostname: "app.customer.com",
          customMetadata: { customer: "acme" },
        })[0].label,
      ).toBe(ENTERPRISE_LABEL);
    });
  });

  // Pricing runs during plan, so props may still contain unresolved Outputs.
  // An unknown Enterprise prop must degrade to a labeled default rather than
  // silently reading as "absent" (which would claim PAYG pricing applies).
  describe("unresolved plan-time Outputs", () => {
    test("an Output customOriginSni says the rate shown is a default", () => {
      const rates = CustomHostnamePricing.rates({
        zoneId: "zone-id",
        hostname: "app.customer.com",
        customOriginSni: asOutput(":request_host_header:"),
      });
      expect(rates[0].label).toBe(UNRESOLVED_LABEL);
      expect(rates[0].perUnit).toBe(0.1);
    });

    test("an unresolved non-Enterprise prop does not flip the label", () => {
      expect(
        CustomHostnamePricing.rates({
          zoneId: "zone-id",
          hostname: "app.customer.com",
          customOriginServer: asOutput("origin.example.com"),
        })[0].label,
      ).toBe(PAYG_LABEL);
    });

    test("an Output customMetadata says the rate shown is a default", () => {
      expect(
        CustomHostnamePricing.rates({
          zoneId: "zone-id",
          hostname: "app.customer.com",
          customMetadata: asOutput({ customer: "acme" }),
        })[0].label,
      ).toBe(UNRESOLVED_LABEL);
    });

    test("a whole-props Output prices like unknown props, with the unresolved label", () => {
      const rates = CustomHostnamePricing.rates(
        asOutput({ zoneId: "zone-id", hostname: "app.customer.com" }),
      );
      expect(rates[0].label).toBe(UNRESOLVED_LABEL);
      expect(rates[0].perUnit).toBe(0.1);
    });

    test("a known Enterprise prop wins over an unresolved sibling", () => {
      const rates = CustomHostnamePricing.rates({
        zoneId: "zone-id",
        hostname: "app.customer.com",
        customOriginSni: ":request_host_header:",
        customMetadata: asOutput({ customer: "acme" }),
      });
      expect(rates[0].label).toBe(ENTERPRISE_LABEL);
    });

    test("an unresolved prop is distinguished from an absent one", () => {
      expect(
        CustomHostnamePricing.rates({
          zoneId: "zone-id",
          hostname: "app.customer.com",
        })[0].label,
      ).not.toContain("unresolved");
    });
  });
});
