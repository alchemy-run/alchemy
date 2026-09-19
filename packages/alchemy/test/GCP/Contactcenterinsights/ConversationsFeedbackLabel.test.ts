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

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  cci.getProjectsLocationsConversationsFeedbackLabels({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsConversationsFeedbackLabels on a missing label fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsConversationsFeedbackLabels({
          name: `projects/${project}/locations/us-central1/conversations/missing/feedbackLabels/missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(
  !hasGcpCreds || !!process.env.FAST || !process.env.GCP_TEST_CCI_ISSUE_MODELS,
)(
  "create, update, and delete a conversation feedback label",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const conversation = yield* GCP.Contactcenterinsights.Conversation(
            "Chat",
            {
              medium: "CHAT",
              languageCode: "en-US",
              labels: { env: "test" },
            },
          );
          return yield* GCP.Contactcenterinsights.ConversationsFeedbackLabel(
            "Topic",
            {
              parent: conversation.name,
              label: "billing",
            },
          );
        }),
      );

      expect(created.name).toContain("/feedbackLabels/");
      expect(created.label).toEqual("billing");

      const fetched =
        yield* cci.getProjectsLocationsConversationsFeedbackLabels({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.label).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const conversation = yield* GCP.Contactcenterinsights.Conversation(
            "Chat",
            {
              medium: "CHAT",
              languageCode: "en-US",
              labels: { env: "test" },
            },
          );
          return yield* GCP.Contactcenterinsights.ConversationsFeedbackLabel(
            "Topic",
            {
              parent: conversation.name,
              feedbackLabelId: created.feedbackLabelId,
              label: "invoices",
            },
          );
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.label).toEqual("invoices");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
