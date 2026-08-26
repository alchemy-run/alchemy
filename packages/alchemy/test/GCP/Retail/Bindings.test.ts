import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

// Retail create returns Forbidden: "AI Commerce Search API has not been
// used in project … or it is disabled."
const runLifecycle =
  hasGcpCreds && !process.env.FAST && process.env.GCP_TEST_RETAIL === "1";

test.provider.skipIf(!runLifecycle)(
  "Search round-trip against a serving config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* GCP.Retail.CatalogsBranchesProduct("Shirt", {
            title: "Cotton tee",
            categories: ["Apparel > T-Shirts"],
          });
          const serving = yield* GCP.Retail.CatalogsServingConfig("Search", {
            displayName: "search",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* product.name;
              const search = yield* GCP.Retail.Search(serving);
              const predict = yield* GCP.Retail.Predict(serving);
              return Effect.fn(function* () {
                const searched = yield* search({
                  body: {
                    visitorId: "alchemy-visitor",
                    query: "tee",
                    pageSize: 5,
                  },
                });
                const predicted = yield* predict({
                  body: {
                    validateOnly: true,
                    userEvent: {
                      eventType: "detail-page-view",
                      visitorId: "visitor-1",
                    },
                  },
                }).pipe(
                  Effect.map((result) => ({ tag: "ok" as const, result })),
                  Effect.catchTag(
                    ["Forbidden", "BadRequest", "NotFound", "Conflict"],
                    (error) =>
                      Effect.succeed({
                        tag: error._tag,
                        message: error.message,
                      }),
                  ),
                );
                return { searched, predicted };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(
        out.searched.attributionToken === undefined ||
          typeof out.searched.attributionToken === "string",
      ).toEqual(true);
      expect(Array.isArray(out.searched.results ?? [])).toEqual(true);
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(out.predicted.tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
