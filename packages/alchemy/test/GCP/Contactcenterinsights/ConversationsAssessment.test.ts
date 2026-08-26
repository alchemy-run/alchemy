import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { uploadChatTranscript } from "./transcript.ts";

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
const transcriptBucket = `alchemy-cci-transcripts-${project}`;
const conversationId = "alchemy-cci-assess-conv";
const conversationName = `projects/${project}/locations/us-central1/conversations/${conversationId}`;

const waitUntilGone = (name: string) =>
  cci.getProjectsLocationsConversationsAssessments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const ensureConversation = Effect.gen(function* () {
  yield* uploadChatTranscript(transcriptBucket);
  const existing = yield* cci
    .getProjectsLocationsConversations({
      name: conversationName,
      view: "BASIC",
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  if (existing !== undefined) return existing;
  return yield* cci.createProjectsLocationsConversations({
    parent: `projects/${project}/locations/us-central1`,
    conversationId,
    body: {
      medium: "CHAT",
      languageCode: "en-US",
      labels: { "alchemy-test": "cci" },
      dataSource: {
        gcsSource: {
          transcriptUri: `gs://${transcriptBucket}/transcript.json`,
        },
      },
    },
  });
});

const deleteConversation = cci
  .deleteProjectsLocationsConversations({
    name: conversationName,
    force: true,
  })
  .pipe(Effect.catchTag("NotFound", () => Effect.void));

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsConversationsAssessments on a missing assessment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsConversationsAssessments({
          name: `${conversationName}/assessments/missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a conversation assessment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const conversation = yield* ensureConversation;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Contactcenterinsights.ConversationsAssessment(
            "QA",
            {
              parent: conversation.name ?? conversationName,
              agentInfo: {
                agentId: "agent-1",
                displayName: "Ada",
                agentType: "HUMAN_AGENT",
              },
            },
          );
        }),
      );

      expect(created.name).toContain("/assessments/");
      expect(created.agentInfo?.displayName).toEqual("Ada");

      const fetched = yield* cci.getProjectsLocationsConversationsAssessments({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.agentInfo?.displayName).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Contactcenterinsights.ConversationsAssessment(
            "QA",
            {
              parent: conversation.name ?? conversationName,
              agentInfo: {
                agentId: "agent-1",
                displayName: "Bob",
                agentType: "HUMAN_AGENT",
              },
            },
          );
        }),
      );
      expect(updated.agentInfo?.displayName).toEqual("Bob");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
      yield* deleteConversation;
    }).pipe(logLevel),
  { timeout: 120_000 },
);
