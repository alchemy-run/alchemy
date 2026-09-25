import * as analytics from "@distilled.cloud/gcp/analyticsadmin_v1beta";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_ANALYTICSADMIN;

export const toAccountName = (value: string) =>
  value.startsWith("accounts/") ? value : `accounts/${value}`;

export const resolveAccountName = () =>
  Effect.gen(function* () {
    const fromEnv = process.env.GCP_ANALYTICS_ACCOUNT?.trim();
    if (fromEnv) return toAccountName(fromEnv);
    const accounts = yield* analytics.listAccounts
      .pages({ pageSize: 200 })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.accounts ?? [])),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () =>
          Effect.succeed([] as analytics.GoogleAnalyticsAdminV1betaAccount[]),
        ),
        Effect.catchTag("Forbidden", () =>
          Effect.succeed([] as analytics.GoogleAnalyticsAdminV1betaAccount[]),
        ),
      );
    return accounts.find((account) => account.name)?.name;
  });

export const waitUntilPropertyGone = (name: string) =>
  analytics.getProperties({ name }).pipe(
    Effect.map((property) =>
      property.deleteTime ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

export const waitUntilDataStreamGone = (name: string) =>
  analytics.getPropertiesDataStreams({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

export const waitUntilConversionEventGone = (name: string) =>
  analytics.getPropertiesConversionEvents({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

export const waitUntilKeyEventGone = (name: string) =>
  analytics.getPropertiesKeyEvents({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

export const waitUntilSecretGone = (name: string) =>
  analytics.getPropertiesDataStreamsMeasurementProtocolSecrets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
