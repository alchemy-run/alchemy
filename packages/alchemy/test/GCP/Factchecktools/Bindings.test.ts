import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  entitlementTags,
  hasGcpCreds,
  logLevel,
  probePageAccess,
  testPageUrl,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "GetPage round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probePageAccess;
      if (access !== "ok") {
        expect(entitlementTags).toContain(access._tag);
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const page = yield* GCP.Factchecktools.Page("Review", {
            pageUrl: testPageUrl,
            claimReviewAuthor: { name: "Alchemy Checks" },
            claimReviewMarkups: [
              {
                claimReviewed: "The moon is made of cheese",
                rating: { textualRating: "False" },
              },
            ],
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* page.name;
              const getPage = yield* GCP.Factchecktools.GetPage(page);
              return Effect.fn(function* () {
                const markup = yield* getPage({});
                return { markup };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(out.markup.pageUrl).toEqual(testPageUrl);
      expect((out.markup.name ?? "").startsWith("pages/")).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
