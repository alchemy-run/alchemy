import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const bidderId = process.env.GCP_ADEXCHANGEBUYER2_BIDDER_ID?.trim();
export const accountId = process.env.GCP_ADEXCHANGEBUYER2_ACCOUNT_ID?.trim();
export const buyerId = process.env.GCP_ADEXCHANGEBUYER2_BUYER_ID?.trim();

export const runLifecycle =
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_ADEXCHANGEBUYER2;

export const runBiddersLifecycle = runLifecycle && !!bidderId;
export const runAccountsLifecycle = runBiddersLifecycle && !!accountId;
export const runBuyersLifecycle = runLifecycle && !!buyerId;

export const probeBidderOwner = bidderId ? `bidders/${bidderId}` : "bidders/1";
export const probeAccountOwner =
  bidderId && accountId
    ? `bidders/${bidderId}/accounts/${accountId}`
    : "bidders/1/accounts/1";
export const probeBuyerOwner = buyerId ? `buyers/${buyerId}` : "buyers/1";
