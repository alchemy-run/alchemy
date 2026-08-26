import * as marketplace from "@distilled.cloud/gcp/authorizedbuyersmarketplace_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const probeParent = "buyers/1/clients/1";
export const probeName = `${probeParent}/users/0`;

const expandParent = (value: string) => {
  const trimmed = value.replace(/\/+$/, "").trim();
  if (trimmed.length === 0) return trimmed;
  if (trimmed.includes("/clients/")) {
    return trimmed.startsWith("buyers/") ? trimmed : `buyers/${trimmed}`;
  }
  return trimmed;
};

const envParent = process.env.GCP_AUTHORIZEDBUYERSMARKETPLACE_PARENT?.trim();
const envBuyer = process.env.GCP_AUTHORIZEDBUYERSMARKETPLACE_BUYER_ID?.trim();
const envClient = process.env.GCP_AUTHORIZEDBUYERSMARKETPLACE_CLIENT_ID?.trim();

export const lifecycleParent = envParent
  ? expandParent(envParent)
  : envBuyer && envClient
    ? expandParent(`${envBuyer}/clients/${envClient}`)
    : probeParent;

export const waitUntilGone = (name: string) =>
  marketplace.getBuyersClientsUsers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
