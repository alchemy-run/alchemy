import * as GCP from "@alchemy.run/gcp";
import { makeObjectMedia } from "@alchemy.run/gcp/Storage/ObjectMedia";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import RepositoryEventsService, { ImageMarkers, Watched } from "./fixtures/repository-events.ts";
import { IMAGE, pushDockerVersion } from "./registry.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "a repository's image pushes and deletions reach an effect-native Function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          yield* RepositoryEventsService;
          const repository = yield* Watched;
          return {
            repository: {
              name: repository.name,
              repositoryId: repository.repositoryId,
              project: repository.project,
              location: repository.location,
            },
            bucket: (yield* ImageMarkers).bucketName,
          };
        }),
      );

      const markerFor = (action: string, digest: string) =>
        storage.listObjects({ bucket: out.bucket, prefix: `${action}/${digest}` }).pipe(
          Effect.map((list) => list.items ?? []),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (items) => items.length > 0,
            times: 36,
          }),
        );
      const media = yield* makeObjectMedia;
      const read = (object: string) =>
        media
          .download({ bucket: out.bucket, object })
          .pipe(Effect.map((downloaded) => JSON.parse(new TextDecoder().decode(downloaded.body))));

      // Out of band: push an image, then delete it.
      const run = yield* Effect.sync(() => crypto.randomUUID().slice(0, 8));
      const version = yield* pushDockerVersion(out.repository, `tag-${run}`);
      const digest = version.split("/versions/")[1]!;
      const [pushed] = yield* markerFor("INSERT", digest);
      expect(yield* read(pushed!.name!)).toMatchObject({
        action: "INSERT",
        digest: expect.stringContaining(
          `${out.repository.location}-docker.pkg.dev/${out.repository.project}/${out.repository.repositoryId}/${IMAGE}@${digest}`,
        ),
      });

      yield* artifactregistry.deleteProjectsLocationsRepositoriesPackagesVersions({
        name: version,
        force: true,
      });
      const [deleted] = yield* markerFor("DELETE", digest);
      expect(yield* read(deleted!.name!)).toMatchObject({ action: "DELETE" });

      yield* stack.destroy();
    }),
  { timeout: 900_000 },
);
