import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// A project to share with is an external identity of the test organization.
const shareProject = process.env.STACKIT_TEST_IMAGE_SHARE_PROJECT;

const options = { tags: stackitTags("iaas", "imageshare"), timeout: 600_000 } as const;

const makeDiskFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-stackit-image-share-" });
  const file = path.join(dir, "disk.raw");
  yield* fs.writeFile(file, new Uint8Array(1024 * 1024).fill(4));
  return file;
});

/** Out-of-band: the image's targets, empty once it isn't shared. */
const observeShare = (projectId: string, region: string, imageId: string) =>
  iaas.getImageShare({ projectId, region, imageId }).pipe(
    Effect.map((share) => ({
      parentOrganization: share.parentOrganization ?? false,
      projects: [...(share.projects ?? [])],
    })),
    Effect.catchTag("NotFound", () =>
      Effect.succeed({ parentOrganization: false, projects: [] as string[] }),
    ),
  );

/** Bounded wait until the image is no longer shared with anyone. */
const expectUnshared = (projectId: string, region: string, imageId: string) =>
  observeShare(projectId, region, imageId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (share) => !share.parentOrganization && share.projects.length === 0,
      times: 10,
    }),
    Effect.map((share) => expect(share).toEqual({ parentOrganization: false, projects: [] })),
  );

const imageAndShare = (
  file: string,
  targets: { parentOrganization?: boolean; projects?: string[] },
) =>
  Effect.gen(function* () {
    const image = yield* Stackit.IaaS.Image("Shared", {
      source: { type: "file", path: file },
      diskFormat: "raw",
    });
    const share = yield* Stackit.IaaS.ImageShare("Share", {
      imageId: image.imageId,
      ...targets,
    });
    return { image, share };
  });

const imageOnly = (file: string) =>
  Stackit.IaaS.Image("Shared", {
    source: { type: "file", path: file },
    diskFormat: "raw",
  });

test.provider(
  "share an image with the organization and remove the share",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const file = yield* makeDiskFile;
      yield* stack.destroy();

      const created = yield* stack.deploy(imageAndShare(file, { parentOrganization: true }));
      expect(created.share.imageId).toEqual(created.image.imageId);
      expect(created.share.parentOrganization).toEqual(true);
      expect(created.share.projects).toEqual([]);

      const observed = yield* observeShare(projectId, region, created.image.imageId);
      expect(observed.parentOrganization).toEqual(true);

      const plan = yield* stack.plan(imageAndShare(file, { parentOrganization: true }));
      expect(plan.resources.Share).toMatchObject({ action: "noop" });

      // Removing the share resource keeps the image, unshared.
      const kept = yield* stack.deploy(imageOnly(file));
      expect(kept.imageId).toEqual(created.image.imageId);
      yield* expectUnshared(projectId, region, created.image.imageId);

      yield* stack.destroy();
    }).pipe(Effect.scoped, logLevel),
  options,
);

test.provider(
  "both kinds of target are refused",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      const file = yield* makeDiskFile;
      yield* stack.destroy();

      const error = yield* stack
        .deploy(imageAndShare(file, { parentOrganization: true, projects: [projectId] }))
        .pipe(Effect.flip);
      expect(error._tag).toEqual("Stackit.IaaS.ImageShareTargetsConflict");

      yield* stack.destroy();
    }).pipe(Effect.scoped, logLevel),
  options,
);

test.provider.skipIf(!shareProject)(
  "switch a share between projects and the organization, replacing out-of-band targets",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const file = yield* makeDiskFile;
      yield* stack.destroy();

      const created = yield* stack.deploy(imageAndShare(file, { projects: [shareProject!] }));
      expect(created.share.projects).toEqual([shareProject]);
      const imageId = created.image.imageId;
      expect((yield* observeShare(projectId, region, imageId)).projects).toEqual([shareProject]);

      const organization = yield* stack.deploy(imageAndShare(file, { parentOrganization: true }));
      expect(organization.share.parentOrganization).toEqual(true);
      expect((yield* observeShare(projectId, region, imageId)).parentOrganization).toEqual(true);

      const back = yield* stack.deploy(imageAndShare(file, { projects: [shareProject!] }));
      expect(back.share.parentOrganization).toEqual(false);
      expect((yield* observeShare(projectId, region, imageId)).projects).toEqual([shareProject]);

      // A share nobody declared, on an image Alchemy owns, is reclaimed.
      yield* stack.deploy(imageOnly(file));
      yield* iaas.setImageShare({ projectId, region, imageId, projects: [shareProject!] });
      const reclaimed = yield* stack.deploy(imageAndShare(file, { parentOrganization: true }));
      expect(reclaimed.share.parentOrganization).toEqual(true);

      yield* stack.destroy();
    }).pipe(Effect.scoped, logLevel),
  options,
);
