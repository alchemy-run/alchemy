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
const datasetId = "alchemy-cci-label-ds";
const conversationId = "alchemy-cci-ds-label-conv";
const locationParent = `projects/${project}/locations/us-central1`;
const datasetName = `${locationParent}/datasets/${datasetId}`;
const conversationName = `${datasetName}/conversations/${conversationId}`;

const waitUntilGone = (name: string) =>
  cci.getProjectsLocationsDatasetsConversationsFeedbackLabels({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilDatasetGone = (name: string) =>
  cci.getProjectsLocationsDatasets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const ensureDataset = cci
  .getProjectsLocationsDatasets({ name: datasetName })
  .pipe(
    Effect.catchTag("NotFound", () =>
      cci.createProjectsLocationsDatasets({
        parent: locationParent,
        datasetId,
        body: {
          displayName: "alchemy-cci-label-ds",
          type: "EVAL",
          description: "alchemy test dataset",
        },
      }),
    ),
  );

const ensureConversation = cci
  .getProjectsLocationsDatasetsConversations({ name: conversationName })
  .pipe(
    Effect.catchTag("NotFound", () =>
      cci.createProjectsLocationsConversations({
        parent: datasetName,
        conversationId,
        body: {
          medium: "CHAT",
          languageCode: "en-US",
          labels: { "alchemy-test": "cci" },
        },
      }),
    ),
  );

const deleteParents = Effect.gen(function* () {
  yield* cci
    .deleteProjectsLocationsDatasetsConversations({
      name: conversationName,
      force: true,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));
  const deleted = yield* cci
    .deleteProjectsLocationsDatasets({ name: datasetName })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  if (deleted !== undefined) {
    yield* waitUntilDatasetGone(datasetName);
  }
});

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsDatasetsConversationsFeedbackLabels on a missing label fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsDatasetsConversationsFeedbackLabels({
          name: `${conversationName}/feedbackLabels/missing`,
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
  "create, update, and delete a dataset conversation feedback label",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* ensureDataset;
      const conversation = yield* ensureConversation;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Contactcenterinsights.DatasetsConversationsFeedbackLabel(
            "Topic",
            {
              parent: conversation.name ?? conversationName,
              label: "billing",
            },
          );
        }),
      );

      expect(created.name).toContain("/feedbackLabels/");
      expect(created.label).toEqual("billing");

      const fetched =
        yield* cci.getProjectsLocationsDatasetsConversationsFeedbackLabels({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.label).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Contactcenterinsights.DatasetsConversationsFeedbackLabel(
            "Topic",
            {
              parent: conversation.name ?? conversationName,
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
      yield* deleteParents;
    }).pipe(logLevel),
  { timeout: 120_000 },
);
