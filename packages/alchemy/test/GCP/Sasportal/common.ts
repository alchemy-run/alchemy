import * as sasportal from "@distilled.cloud/gcp/sasportal_v1alpha1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const runLifecycle =
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_SASPORTAL;

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const firstCustomerName = Effect.gen(function* () {
  const fromEnv = process.env.GCP_TEST_SASPORTAL_CUSTOMER?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv.includes("/") ? fromEnv : `customers/${fromEnv}`;
  }
  const page = yield* sasportal.listCustomers({ pageSize: 10 });
  return page.customers?.[0]?.name ?? "";
});

/** Constant CPI-signed-device probe body. Never generated at test time. */
export const signedDeviceProbe = {
  encodedDevice:
    "eyJhbGciOiJub25lIn0.eyJkaXNwbGF5TmFtZSI6ImFsY2hlbXktc2FzcG9ydGFsLXByb2JlIiwiZmNjSWQiOiJURVNURkNDIiwic2VyaWFsTnVtYmVyIjoiQUxDSEVNWVBST0JFIn0.",
  installerId: "alchemy-installer",
};
