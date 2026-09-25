import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

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

const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  !!process.env.GCP_TEST_CONTACTCENTERINSIGHTS;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  cci.getProjectsLocationsAuthorizedViewSetsAuthorizedViews({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsAuthorizedViewSetsAuthorizedViews on a missing view fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsAuthorizedViewSetsAuthorizedViews({
          name: `projects/${project}/locations/us-central1/authorizedViewSets/alchemy-missing-set/authorizedViews/alchemy-missing-view`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an authorized view",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const set = yield* GCP.Contactcenterinsights.AuthorizedViewSet(
            "QaViews",
            { displayName: "qa" },
          );
          const view =
            yield* GCP.Contactcenterinsights.AuthorizedViewSetsAuthorizedView(
              "Reviewers",
              {
                parent: set.name,
                displayName: "reviewers",
              },
            );
          return { set, view };
        }),
      );

      expect(created.view.authorizedViewId).toEqual(expect.any(String));
      expect(created.view.name).toContain("/authorizedViews/");
      expect(created.view.parent).toEqual(created.set.name);
      expect(created.view.displayName).toEqual("reviewers");

      const fetched =
        yield* cci.getProjectsLocationsAuthorizedViewSetsAuthorizedViews({
          name: created.view.name,
        });
      expect(fetched.name).toEqual(created.view.name);
      expect(fetched.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const set = yield* GCP.Contactcenterinsights.AuthorizedViewSet(
            "QaViews",
            {
              authorizedViewSetId: created.set.authorizedViewSetId,
              location: "us-central1",
              displayName: "qa",
            },
          );
          const view =
            yield* GCP.Contactcenterinsights.AuthorizedViewSetsAuthorizedView(
              "Reviewers",
              {
                parent: set.name,
                authorizedViewId: created.view.authorizedViewId,
                displayName: "reviewers-v2",
                conversationFilter: 'language_code="en-US"',
              },
            );
          return { set, view };
        }),
      );

      expect(updated.view.name).toEqual(created.view.name);
      expect(updated.view.displayName).toEqual("reviewers-v2");
      expect(updated.view.conversationFilter).toEqual('language_code="en-US"');

      const fetchedUpdate =
        yield* cci.getProjectsLocationsAuthorizedViewSetsAuthorizedViews({
          name: updated.view.name,
        });
      expect(fetchedUpdate.conversationFilter).toEqual('language_code="en-US"');

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.view.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
