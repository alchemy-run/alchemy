import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as ssm from "@distilled.cloud/gcp/securesourcemanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  logLevel,
  missingPullRequest,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  ssm
    .getProjectsLocationsRepositoriesPullRequestsPullRequestComments({
      name,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsRepositoriesPullRequestsPullRequestComments on a missing comment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        ssm.getProjectsLocationsRepositoriesPullRequestsPullRequestComments({
          name: `${missingPullRequest}/pullRequestComments/alchemy-missing-comment`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create against a missing pull request is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Securesourcemanager.RepositoriesPullRequestsPullRequestComment(
              "Note",
              {
                pullRequest: missingPullRequest,
                comment: { body: "looks good" },
              },
            );
          }),
        ),
      );
      expect([
        "NotFound",
        "Forbidden",
        "BadRequest",
        "GCP.Securesourcemanager.OperationFailed",
        "GCP.Securesourcemanager.ResourceNotResolved",
      ]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a pull request comment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Securesourcemanager.RepositoriesPullRequestsPullRequestComment(
            "Note",
            {
              pullRequest:
                process.env.GCP_TEST_SECURE_SOURCE_MANAGER_PULL_REQUEST ??
                missingPullRequest,
              comment: { body: "looks good" },
            },
          );
        }),
      );

      expect(created.name).toContain("/pullRequestComments/");
      expect(created.comment?.body).toEqual("looks good");

      const fetched =
        yield* ssm.getProjectsLocationsRepositoriesPullRequestsPullRequestComments(
          { name: created.name },
        );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.comment?.body).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Securesourcemanager.RepositoriesPullRequestsPullRequestComment(
            "Note",
            {
              pullRequest: created.pullRequest,
              commentId: created.commentId,
              comment: { body: "looks good after the rebase" },
            },
          );
        }),
      );

      expect(updated.commentId).toEqual(created.commentId);
      expect(updated.comment?.body).toEqual("looks good after the rebase");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
