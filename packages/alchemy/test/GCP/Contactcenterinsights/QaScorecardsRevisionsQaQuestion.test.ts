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
  cci.getProjectsLocationsQaScorecardsRevisionsQaQuestions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsQaScorecardsRevisionsQaQuestions on a missing question fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsQaScorecardsRevisionsQaQuestions({
          name: `projects/${project}/locations/us-central1/qaScorecards/missing/revisions/missing/qaQuestions/missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a qa question",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const card = yield* GCP.Contactcenterinsights.QaScorecard("Quality", {
            location: "us-central1",
            displayName: "quality",
            description: "call quality",
          });
          const revision =
            yield* GCP.Contactcenterinsights.QaScorecardsRevision("V1", {
              parent: card.name,
            });
          return yield* GCP.Contactcenterinsights.QaScorecardsRevisionsQaQuestion(
            "Greeting",
            {
              parent: revision.name,
              abbreviation: "Greeting",
              questionBody: "Did the agent greet the customer?",
              answerInstructions: "Listen for a greeting in the first turn.",
              answerChoices: [
                { strValue: "Yes", score: 1 },
                { strValue: "No", score: 0 },
              ],
            },
          );
        }),
      );

      expect(created.name).toContain("/qaQuestions/");
      expect(created.abbreviation).toEqual("Greeting");
      expect(created.questionBody).toEqual("Did the agent greet the customer?");
      expect(created.answerInstructions).toEqual(
        "Listen for a greeting in the first turn.",
      );

      const fetched =
        yield* cci.getProjectsLocationsQaScorecardsRevisionsQaQuestions({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.answerInstructions).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const card = yield* GCP.Contactcenterinsights.QaScorecard("Quality", {
            location: "us-central1",
            displayName: "quality",
            description: "call quality",
          });
          const revision =
            yield* GCP.Contactcenterinsights.QaScorecardsRevision("V1", {
              parent: card.name,
            });
          return yield* GCP.Contactcenterinsights.QaScorecardsRevisionsQaQuestion(
            "Greeting",
            {
              parent: revision.name,
              qaQuestionId: created.qaQuestionId,
              abbreviation: "Intro",
              questionBody: "Did the agent introduce themselves?",
              answerInstructions: "Listen for a name in the first turn.",
              answerChoices: [
                { strValue: "Yes", score: 1 },
                { strValue: "No", score: 0 },
              ],
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.abbreviation).toEqual("Intro");
      expect(updated.questionBody).toEqual(
        "Did the agent introduce themselves?",
      );

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
