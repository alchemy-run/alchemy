import { createHash } from "node:crypto";
import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, GONE, PRESENT, slow } from "./compute.ts";

const { test } = makeStackitTest();

// A 1 MiB image costs fractions of a cent, so the upload lifecycle is ungated.
// Copying a volume takes many minutes, so that case is behind the slow flag.
const options = { tags: stackitTags("iaas", "image"), timeout: 600_000 } as const;

const presence = (projectId: string, region: string, imageId: string) =>
  iaas.getImage({ projectId, region, imageId }).pipe(
    Effect.map((image) => (image.status === "DELETED" ? GONE : PRESENT)),
    Effect.catchTag("NotFound", () => Effect.succeed(GONE)),
  );

/** A 1 MiB raw disk filled with one byte, so each fill has its own digest. */
const rawDisk = (fill: number) => new Uint8Array(1024 * 1024).fill(fill);

const sha512Of = (bytes: Uint8Array) =>
  Effect.sync(() => createHash("sha512").update(bytes).digest("hex"));

/** A temp file to upload, and a function replacing its content. */
const makeImageFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-stackit-image-" });
  const file = path.join(dir, "disk.raw");
  return { file, write: (bytes: Uint8Array) => fs.writeFile(file, bytes) };
});

test.provider(
  "upload, update, replace on new content, and delete an image",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const { file, write } = yield* makeImageFile;
      yield* stack.destroy();

      const first = rawDisk(1);
      yield* write(first);
      const image = (labels: Record<string, string>, more: { name?: string; minRam?: number }) =>
        Stackit.IaaS.Image("Disk", {
          source: { type: "file", path: file },
          diskFormat: "raw",
          minDiskSize: 1,
          labels,
          ...more,
        });

      const created = yield* stack.deploy(image({ env: "test" }, { minRam: 512 }));
      expect(created.imageId).toEqual(expect.any(String));
      expect(created.status).toEqual("AVAILABLE");
      expect(created.diskFormat).toEqual("raw");
      expect(created.fileSha512).toEqual(yield* sha512Of(first));

      const fetched = yield* iaas.getImage({ projectId, region, imageId: created.imageId });
      expect(fetched.status).toEqual("AVAILABLE");
      expect(fetched.minDiskSize).toEqual(1);
      expect(fetched.minRam).toEqual(512);
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({
        env: "test",
        "alchemy.id": "Disk",
      });

      const provider = yield* Provider.findProvider(Stackit.IaaS.Image);
      const listed = yield* provider.list();
      expect(listed.map((listedImage) => listedImage.imageId)).toContain(created.imageId);

      // Unchanged props and content plan nothing.
      const unchanged = yield* stack.plan(image({ env: "test" }, { minRam: 512 }));
      expect(unchanged.resources.Disk).toMatchObject({ action: "noop" });

      // Name, labels and requirements update in place.
      const updated = yield* stack.deploy(
        image({ env: "prod" }, { name: "alchemy-test-image-renamed", minRam: 1024 }),
      );
      expect(updated.imageId).toEqual(created.imageId);
      const refetched = yield* iaas.getImage({ projectId, region, imageId: created.imageId });
      expect(refetched.name).toEqual("alchemy-test-image-renamed");
      expect(refetched.minRam).toEqual(1024);
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });

      // New content under the same path replaces the image.
      const second = rawDisk(2);
      yield* write(second);
      const changed = yield* stack.plan(image({ env: "prod" }, { minRam: 1024 }));
      expect(changed.resources.Disk).toMatchObject({ action: "replace" });
      const replaced = yield* stack.deploy(image({ env: "prod" }, { minRam: 1024 }));
      expect(replaced.imageId).not.toEqual(created.imageId);
      expect(replaced.fileSha512).toEqual(yield* sha512Of(second));
      yield* expectGone(presence(projectId, region, created.imageId));

      yield* stack.destroy();
      yield* expectGone(presence(projectId, region, replaced.imageId));
    }).pipe(Effect.scoped, logLevel),
  options,
);

test.provider(
  "a protected image can be unprotected and then deleted",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const { file, write } = yield* makeImageFile;
      yield* stack.destroy();

      yield* write(rawDisk(3));
      const image = (isProtected: boolean) =>
        Stackit.IaaS.Image("Protected", {
          source: { type: "file", path: file },
          diskFormat: "raw",
          protected: isProtected,
        });

      const created = yield* stack.deploy(image(true));
      expect(created.protected).toEqual(true);

      const unprotected = yield* stack.deploy(image(false));
      expect(unprotected.imageId).toEqual(created.imageId);
      const fetched = yield* iaas.getImage({ projectId, region, imageId: created.imageId });
      expect(fetched.protected).toEqual(false);

      yield* stack.destroy();
      yield* expectGone(presence(projectId, region, created.imageId));
    }).pipe(Effect.scoped, logLevel),
  options,
);

test.provider(
  "an empty file fails before anything is created",
  (stack) =>
    Effect.gen(function* () {
      const { file, write } = yield* makeImageFile;
      yield* stack.destroy();

      yield* write(new Uint8Array(0));
      const error = yield* stack
        .deploy(
          Stackit.IaaS.Image("Empty", {
            source: { type: "file", path: file },
            diskFormat: "raw",
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("Stackit.IaaS.ImageFileInvalid");

      yield* stack.destroy();
    }).pipe(Effect.scoped, logLevel),
  options,
);

// Both volumes stay deployed across steps so a replacement never removes the
// dependency it is moving away from.
const imageOfVolume = (source: "A" | "B", labels: Record<string, string>) =>
  Effect.gen(function* () {
    const a = yield* Stackit.IaaS.Volume("ImageVolumeA", { size: 1 });
    const b = yield* Stackit.IaaS.Volume("ImageVolumeB", { size: 1 });
    const image = yield* Stackit.IaaS.Image("FromVolume", {
      source: { type: "volume", volumeId: source === "A" ? a.volumeId : b.volumeId },
      diskFormat: "qcow2",
      labels,
    });
    return { a, b, image };
  });

test.provider.skipIf(slow)(
  "copy a volume, update, replace on another volume, and delete the image",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(imageOfVolume("A", { env: "test" }));
      expect(created.image.status).toEqual("AVAILABLE");
      expect(created.image.sourceVolumeId).toEqual(created.a.volumeId);
      expect(created.image.fileSha512).toBeUndefined();

      // STACKIT takes no labels when copying a volume: the sync step sets them.
      const fetched = yield* iaas.getImage({
        projectId,
        region,
        imageId: created.image.imageId,
      });
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({
        env: "test",
        "alchemy.id": "FromVolume",
      });

      const unchanged = yield* stack.plan(imageOfVolume("A", { env: "test" }));
      expect(unchanged.resources.FromVolume).toMatchObject({ action: "noop" });

      const updated = yield* stack.deploy(imageOfVolume("A", { env: "prod" }));
      expect(updated.image.imageId).toEqual(created.image.imageId);
      const refetched = yield* iaas.getImage({
        projectId,
        region,
        imageId: created.image.imageId,
      });
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });

      const replaced = yield* stack.deploy(imageOfVolume("B", { env: "prod" }));
      expect(replaced.image.imageId).not.toEqual(created.image.imageId);
      expect(replaced.image.sourceVolumeId).toEqual(replaced.b.volumeId);
      yield* expectGone(presence(projectId, region, created.image.imageId));

      yield* stack.destroy();
      yield* expectGone(presence(projectId, region, replaced.image.imageId));
    }).pipe(logLevel),
  { tags: stackitTags("iaas", "image"), timeout: 1_800_000 },
);
