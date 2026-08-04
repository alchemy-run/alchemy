import { EmailSendingPricing } from "@/Cloudflare/Email/Pricing";
import { asOutput } from "@/Output";
import { describe, expect, test } from "alchemy-test";

const props = { zoneId: "zone", name: "mail.example.com" };

describe("EmailSendingPricing", () => {
  describe("floorMonthlyUsd — a sending subdomain costs nothing until email is sent", () => {
    test("floors to $0 with no props", () => {
      expect(EmailSendingPricing.floorMonthlyUsd(undefined)).toBe(0);
    });

    test("floors to $0 for a configured sending subdomain", () => {
      expect(EmailSendingPricing.floorMonthlyUsd(props)).toBe(0);
    });
  });

  describe("requiresPaidPlan", () => {
    test("sending to arbitrary recipients requires the Workers Paid plan", () => {
      expect(EmailSendingPricing.requiresPaidPlan).toBe(true);
    });
  });

  describe("rates", () => {
    test("exposes the $0.35 per 1,000 emails send rate", () => {
      const rates = EmailSendingPricing.rates(props);
      expect(rates).toHaveLength(1);
      expect(rates[0].label).toBe("Email Service outbound sends");
      expect(rates[0].perUnit).toBe(0.35);
      expect(rates[0].unit).toBe("1,000 emails");
      expect(rates[0].freeIncluded).toBe(
        "3,000/mo free (sends to verified destination addresses are always free)",
      );
    });

    test("the same rate applies with no props at all", () => {
      expect(EmailSendingPricing.rates(undefined)).toEqual(
        EmailSendingPricing.rates(props),
      );
    });
  });

  // Pricing runs during plan, so — like a provider `diff`'s `news` — props
  // may still contain unresolved Outputs. Nothing on a sending subdomain
  // changes the rate, so an unknown value must simply leave it intact.
  describe("unresolved plan-time Outputs", () => {
    test("an Output zoneId does not disturb the rate", () => {
      const rates = EmailSendingPricing.rates({
        zoneId: asOutput("zone"),
        name: "mail.example.com",
      });
      expect(rates[0].label).toBe("Email Service outbound sends");
      expect(rates[0].perUnit).toBe(0.35);
    });

    test("a whole-props Output prices identically", () => {
      const unresolved = asOutput(props);
      expect(EmailSendingPricing.floorMonthlyUsd(unresolved)).toBe(0);
      expect(EmailSendingPricing.rates(unresolved)).toEqual(
        EmailSendingPricing.rates(props),
      );
    });
  });
});
