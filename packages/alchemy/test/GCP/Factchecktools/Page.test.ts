import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as factchecktools from "@distilled.cloud/gcp/factchecktools_v1alpha1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { PROBE_NAME, PROBE_PAGE_URL } from "@/GCP/Factchecktools/internal.ts";
import {
  entitlementTags,
  hasGcpCreds,
  logLevel,
  probePageAccess,
  testPageUrl,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  factchecktools.getPages({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getPages on a missing page fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        factchecktools.getPages({ name: PROBE_NAME }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createPages without Fact Check Tools access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* factchecktools
        .createPages({
          body: {
            pageUrl: PROBE_PAGE_URL,
            claimReviewAuthor: { name: "Alchemy" },
            claimReviewMarkups: [
              {
                claimReviewed: "alchemy probe",
                rating: { textualRating: "False" },
              },
            ],
          },
        })
        .pipe(Effect.result);

      if (Result.isSuccess(result)) {
        if (result.success.name) {
          yield* factchecktools
            .deletePages({ name: result.success.name })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }
      } else {
        expect(entitlementTags).toContain(result.failure._tag);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a ClaimReview page",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probePageAccess;
      if (access !== "ok") {
        expect(entitlementTags).toContain(access._tag);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Factchecktools.Page("Review", {
            pageUrl: testPageUrl,
            claimReviewAuthor: { name: "Alchemy Checks" },
            claimReviewMarkups: [
              {
                claimReviewed: "The moon is made of cheese",
                rating: { textualRating: "False" },
              },
            ],
          });
        }),
      );

      expect(created.name.startsWith("pages/")).toEqual(true);
      expect(created.pageId.length).toBeGreaterThan(0);
      expect(created.pageUrl).toEqual(testPageUrl);
      expect(created.claimReviewMarkups[0]?.claimReviewed).toEqual(
        "The moon is made of cheese",
      );

      const fetched = yield* factchecktools.getPages({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.claimReviewMarkups?.[0]?.claimReviewed).toContain(
        "alchemy-",
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Factchecktools.Page("Review", {
            name: created.name,
            pageUrl: testPageUrl,
            claimReviewAuthor: { name: "Alchemy Checks" },
            claimReviewMarkups: [
              {
                claimReviewed: "The moon is made of cheese",
                rating: { textualRating: "Pants on fire" },
              },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.claimReviewMarkups[0]?.rating?.textualRating).toEqual(
        "Pants on fire",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
