import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datalabeling from "@distilled.cloud/gcp/datalabeling_v1beta1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  hasGcpCreds,
  logLevel,
  probe,
  probeErrorTags,
  project,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsDatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessages on a missing message fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        probe(
          datalabeling.getProjectsDatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessages(
            {
              name: `projects/${project}/datasets/missing/annotatedDatasets/missing/feedbackThreads/missing/feedbackMessages/alchemy-missing`,
            },
          ),
        ),
      );
      expect(probeErrorTags).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, replace, and delete a feedback message",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const threadParent = `projects/${project}/datasets/missing/annotatedDatasets/missing/feedbackThreads/missing`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Datalabeling.DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessage(
            "Note",
            {
              parent: threadParent,
              body: "please relabel the occluded boxes",
            },
          );
        }),
      );

      expect(created.name).toContain("/feedback");
      expect(created.body).toEqual("please relabel the occluded boxes");

      const fetched =
        yield* datalabeling.getProjectsDatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessages(
          { name: created.name },
        );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.body).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Datalabeling.DatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessage(
            "Note",
            {
              parent: created.parent,
              feedbackMessageId: created.feedbackMessageId,
              body: "updated relabel note",
            },
          );
        }),
      );

      expect(updated.body).toEqual("updated relabel note");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datalabeling.getProjectsDatasetsAnnotatedDatasetsFeedbackThreadsFeedbackMessages(
          { name: updated.name },
        ),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
