import * as Cloudflare from "@/Cloudflare/index.ts";

export const UnrestrictedSender = Cloudflare.SendEmail("EmailUnrestricted");

export const RestrictedDestSender = Cloudflare.SendEmail(
  "EmailRestrictedDest",
  {
    destinationAddress: "ops@example.com",
  },
);

export const AllowedDestsSender = Cloudflare.SendEmail("EmailAllowedDests", {
  allowedDestinationAddresses: ["ops@example.com", "alerts@example.com"],
});

export const AllowedSendersSender = Cloudflare.SendEmail(
  "EmailAllowedSenders",
  {
    allowedSenderAddresses: ["noreply@example.com"],
  },
);
