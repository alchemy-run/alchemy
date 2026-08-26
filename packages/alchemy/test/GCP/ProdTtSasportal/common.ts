import * as sas from "@distilled.cloud/gcp/prod_tt_sasportal_v1alpha1";
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

export const runLifecycle =
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_PROD_TT_SASPORTAL;

const isMissing = <E extends { readonly _tag: string }>(
  error: E,
): error is Extract<E, { readonly _tag: "NotFound" | "Forbidden" }> =>
  error._tag === "NotFound" || error._tag === "Forbidden";

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: (name: string) => Effect.Effect<A, E, R>,
  name: string,
) =>
  get(name).pipe(
    Effect.as("found" as const),
    Effect.catchIf(isMissing, () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

export const firstCustomerName = () =>
  sas.listCustomers({ pageSize: 10 }).pipe(
    Effect.map((page) => page.customers?.[0]?.name),
    Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

/** Unsigned JWT used only for createSigned entitlement probes. */
export const probeJwt =
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJ1c2VySWQiOiJhbGNoZW15LXByb2JlIn0.";
