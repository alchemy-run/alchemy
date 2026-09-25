import * as factchecktools from "@distilled.cloud/gcp/factchecktools_v1alpha1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { PROBE_PAGE_URL } from "@/GCP/Factchecktools/internal.ts";

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const entitlementTags = ["Forbidden", "BadRequest", "NotFound"] as const;

export const testPageUrl =
  process.env.GCP_TEST_FACTCHECK_PAGE_URL ??
  "https://example.com/fact-check/alchemy-page";

export const probePageAccess = factchecktools
  .createPages({
    body: {
      pageUrl: process.env.GCP_TEST_FACTCHECK_PAGE_URL ?? PROBE_PAGE_URL,
      claimReviewAuthor: { name: "Alchemy" },
      claimReviewMarkups: [
        {
          claimReviewed: "alchemy probe",
          rating: { textualRating: "False" },
        },
      ],
    },
  })
  .pipe(
    Effect.flatMap((page) =>
      page.name
        ? factchecktools.deletePages({ name: page.name }).pipe(
            Effect.as("ok" as const),
            Effect.catchTag("NotFound", () => Effect.succeed("ok" as const)),
          )
        : Effect.succeed("ok" as const),
    ),
    Effect.catchTag("Conflict", () => Effect.succeed("ok" as const)),
    Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
    Effect.catchTag("BadRequest", (error) => Effect.succeed(error)),
    Effect.catchTag("NotFound", (error) => Effect.succeed(error)),
  );
