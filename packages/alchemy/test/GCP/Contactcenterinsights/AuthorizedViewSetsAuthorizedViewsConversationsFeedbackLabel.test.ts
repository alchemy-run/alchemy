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
  cci
    .getProjectsLocationsAuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabels(
      { name },
    )
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "get feedback label on a missing resource fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsAuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabels(
          {
            name: `projects/${project}/locations/us-central1/authorizedViewSets/missing-set/authorizedViews/missing-view/conversations/missing-conv/feedbackLabels/missing-label`,
          },
        ),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a feedback label through an authorized view",
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
              { parent: set.name, displayName: "reviewers" },
            );
          const conversation = yield* GCP.Contactcenterinsights.Conversation(
            "Chat",
            {
              medium: "CHAT",
              languageCode: "en-US",
              agentId: "agent-1",
              labels: { env: "test" },
            },
          );
          const feedback =
            yield* GCP.Contactcenterinsights.AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabel(
              "Topic",
              {
                parent: `${view.name}/conversations/${conversation.conversationId}`,
                label: "billing",
              },
            );
          return { set, view, conversation, feedback };
        }),
      );

      expect(created.feedback.feedbackLabelId).toEqual(expect.any(String));
      expect(created.feedback.name).toContain("/feedbackLabels/");
      expect(created.feedback.label).toEqual("billing");

      const fetched =
        yield* cci.getProjectsLocationsAuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabels(
          { name: created.feedback.name },
        );
      expect(fetched.name).toEqual(created.feedback.name);
      expect(fetched.label).toContain("alchemy-id=");
      expect(fetched.label).toContain("billing");

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
                displayName: "reviewers",
              },
            );
          const conversation = yield* GCP.Contactcenterinsights.Conversation(
            "Chat",
            {
              conversationId: created.conversation.conversationId,
              location: "us-central1",
              medium: "CHAT",
              languageCode: "en-US",
              agentId: "agent-1",
              labels: { env: "test" },
            },
          );
          const feedback =
            yield* GCP.Contactcenterinsights.AuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabel(
              "Topic",
              {
                parent: `${view.name}/conversations/${conversation.conversationId}`,
                feedbackLabelId: created.feedback.feedbackLabelId,
                label: "support",
              },
            );
          return { set, view, conversation, feedback };
        }),
      );

      expect(updated.feedback.name).toEqual(created.feedback.name);
      expect(updated.feedback.label).toEqual("support");

      const fetchedUpdate =
        yield* cci.getProjectsLocationsAuthorizedViewSetsAuthorizedViewsConversationsFeedbackLabels(
          { name: updated.feedback.name },
        );
      expect(fetchedUpdate.label).toContain("support");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.feedback.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
