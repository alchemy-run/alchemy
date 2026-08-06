import {
  ACM_MONTHLY_USD,
  CertificatePackPricing,
} from "@/Cloudflare/Ssl/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

describe("CertificatePackPricing", () => {
  describe("floor — ACM is a real zero-usage subscription", () => {
    test("floors to the $10/mo Advanced Certificate Manager fee", () => {
      expect(ACM_MONTHLY_USD).toBe(10);
      expect(CertificatePackPricing.floorMonthlyUsd(undefined)).toBe(10);
    });

    test("the floor does not depend on any prop", () => {
      const floor = CertificatePackPricing.floorMonthlyUsd;
      expect(floor({} as never)).toBe(10);
      expect(
        floor({
          zoneId: "zone-id",
          certificateAuthority: "google",
          hosts: ["example.com", "*.example.com"],
          validationMethod: "txt",
          validityDays: 90,
        }),
      ).toBe(10);
      expect(
        floor({
          zoneId: "zone-id",
          certificateAuthority: "lets_encrypt",
          hosts: ["example.com"],
          validationMethod: "http",
          validityDays: 14,
          cloudflareBranding: true,
        }),
      ).toBe(10);
    });
  });

  describe("requiresPaidPlan", () => {
    test("ACM is a zone add-on, not the Workers Paid plan", () => {
      expect(CertificatePackPricing.requiresPaidPlan).toBe(false);
    });
  });

  describe("rates", () => {
    test("exposes the subscription as a single per-zone reference line", () => {
      const rates = CertificatePackPricing.rates(undefined);
      expect(rates).toHaveLength(1);
      expect(rates[0].perUnit).toBe(10);
      expect(rates[0].unit).toBe("zone-month");
      expect(rates[0].freeIncluded).toBeUndefined();
    });

    test("the label says the fee is per zone, not per pack", () => {
      const [rate] = CertificatePackPricing.rates(undefined);
      expect(rate.label).toContain("Advanced Certificate Manager");
      expect(rate.label).toContain("billed per zone");
    });
  });

  // No prop moves the ACM price, so an unresolved prop cannot mis-price a
  // certificate pack — pin that, since it is the whole reason this model
  // needs no `planProp` guard.
  describe("unresolved plan-time Outputs", () => {
    test("an Output-valued zoneId prices identically to a concrete one", () => {
      const unresolved = CertificatePackPricing.rates({
        zoneId: asOutput("zone-id"),
        certificateAuthority: "google",
        hosts: ["example.com"],
        validationMethod: "txt",
        validityDays: 90,
      });
      expect(unresolved).toEqual(CertificatePackPricing.rates(undefined));
      expect(
        CertificatePackPricing.floorMonthlyUsd({
          zoneId: asOutput("zone-id"),
          certificateAuthority: "google",
          hosts: ["example.com"],
          validationMethod: "txt",
          validityDays: 90,
        }),
      ).toBe(10);
    });

    test("a whole-props Output still prices at the full subscription", () => {
      const props = asOutput({
        zoneId: "zone-id",
        certificateAuthority: "google" as const,
        hosts: ["example.com"],
        validationMethod: "txt" as const,
        validityDays: 90 as const,
      });
      expect(CertificatePackPricing.floorMonthlyUsd(props)).toBe(10);
      expect(CertificatePackPricing.rates(props)).toEqual(
        CertificatePackPricing.rates(undefined),
      );
    });
  });
});
