import * as AWS from "@/AWS";
import { Image } from "@/AWS/ECR/Image.ts";
import { Repository } from "@/AWS/ECR/Repository.ts";
import * as Test from "@/Test/Alchemy";
import * as ecr from "@distilled.cloud/aws/ecr";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Checked-in build fixture: `FROM scratch` + one COPY'd file, so the build is
// fully deterministic and never fetches a base image over the network.
const fixtureDir = `${import.meta.dirname}/fixtures/image`;

test.provider(
  "PR 1591: build, push, relocate without update, rebuild on content change, destroy",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* stack.destroy();

      // Keep both relocation and content edits outside the checked-in fixture.
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-ecr-image-1591-",
      });
      const context = path.join(root, "original");
      const relocated = path.join(root, "relocated");
      yield* fs.copy(fixtureDir, context);

      const program = (context: string) =>
        Effect.gen(function* () {
          const repository = yield* Repository("ImageRepository", {});
          return yield* Image("Image", {
            repositoryUri: repository.repositoryUri,
            context,
          });
        });

      const first = yield* stack.deploy(program(context));
      expect(first.ownsRepository).toBe(false);
      expect(first.digest).toMatch(/^sha256:/);
      expect(first.imageUri).toBe(`${first.repositoryUri}:${first.imageTag}`);

      // Out-of-band: the manifest exists in ECR with the reported digest.
      const described = yield* ecr.describeImages({
        repositoryName: first.repositoryName,
        imageIds: [{ imageTag: first.imageTag }],
      });
      expect(described.imageDetails?.[0]?.imageDigest).toBe(first.digest);
      expect(described.imageDetails?.[0]?.imagePushedAt).toBeDefined();

      const unchangedPlan = yield* stack.plan(program(context));
      expect(unchangedPlan.resources["Image"]).toMatchObject({
        action: "noop",
      });
      const second = yield* stack.deploy(program(context));
      expect(second.imageTag).toBe(first.imageTag);
      expect(second.digest).toBe(first.digest);

      // Renaming preserves the bytes and permissions used by the content hash.
      yield* fs.rename(context, relocated);
      const relocatedPlan = yield* stack.plan(program(relocated));
      expect(relocatedPlan.resources["Image"]).toMatchObject({
        action: "noop",
      });
      const moved = yield* stack.deploy(program(relocated));
      expect(moved.repositoryUri).toBe(first.repositoryUri);
      expect(moved.imageUri).toBe(first.imageUri);
      expect(moved.imageTag).toBe(first.imageTag);
      expect(moved.digest).toBe(first.digest);
      const movedDescription = yield* ecr.describeImages({
        repositoryName: moved.repositoryName,
        imageIds: [{ imageTag: moved.imageTag }],
      });
      expect(movedDescription.imageDetails?.[0]?.imageDigest).toBe(
        first.digest,
      );
      expect(movedDescription.imageDetails?.[0]?.imagePushedAt).toEqual(
        described.imageDetails?.[0]?.imagePushedAt,
      );

      // Changed bytes at the relocated path must still schedule a rebuild.
      yield* fs.writeFileString(
        path.join(relocated, "hello.txt"),
        "hello again from alchemy\n",
      );
      const changedPlan = yield* stack.plan(program(relocated));
      expect(changedPlan.resources["Image"]).toMatchObject({
        action: "update",
      });
      const third = yield* stack.deploy(program(relocated));
      expect(third.repositoryUri).toBe(first.repositoryUri);
      expect(third.imageTag).not.toBe(first.imageTag);
      expect(third.digest).not.toBe(first.digest);
      const redescribed = yield* ecr.describeImages({
        repositoryName: third.repositoryName,
        imageIds: [{ imageTag: third.imageTag }],
      });
      expect(redescribed.imageDetails?.[0]?.imageDigest).toBe(third.digest);

      yield* stack.destroy();

      // The Repository owns the repo and force-deletes it (taking every
      // image tag with it).
      yield* assertRepositoryDeleted(first.repositoryName);
    }).pipe(Effect.scoped),
  { timeout: 120_000 },
);

test.provider(
  "auto-creates and owns a repository when none is given",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const image = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Image("OwnedImage", {
            context: fixtureDir,
          });
        }),
      );

      expect(image.ownsRepository).toBe(true);
      expect(image.digest).toMatch(/^sha256:/);

      // Out-of-band: the auto-created repository holds the pushed manifest.
      const described = yield* ecr.describeImages({
        repositoryName: image.repositoryName,
        imageIds: [{ imageTag: image.imageTag }],
      });
      expect(described.imageDetails?.[0]?.imageDigest).toBe(image.digest);

      yield* stack.destroy();

      // Destroying an owning Image force-deletes its repository.
      yield* assertRepositoryDeleted(image.repositoryName);
    }),
  { timeout: 240_000 },
);

class RepositoryStillExists extends Data.TaggedError("RepositoryStillExists") {}

const assertRepositoryDeleted = Effect.fn(function* (repositoryName: string) {
  yield* ecr.describeRepositories({ repositoryNames: [repositoryName] }).pipe(
    Effect.flatMap(() => Effect.fail(new RepositoryStillExists())),
    Effect.retry({
      while: (e) => e._tag === "RepositoryStillExists",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
    Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
  );
});
