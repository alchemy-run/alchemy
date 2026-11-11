import * as DigitalOcean from "@alchemy.run/digitalocean";
import { ignoreNotFound } from "@alchemy.run/digitalocean/internal/notFound";
import { hashOwnershipTag } from "@alchemy.run/digitalocean/internal/ownership";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  createVolume,
  deleteTag,
  deleteVolume,
  getTag,
  getVolume,
} from "@distilled.cloud/digitalocean";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import { forgetAttributes, isGone, logLevel, testName } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const REGION = "sfo3";
const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:volume", "live"];
const LIVE_TIMEOUT = 240_000;

const readVolume = (volumeId: string) =>
  getVolume({ volume_id: volumeId }).pipe(Effect.map((response) => response.volume));

const isVolumeGone = (volumeId: string) => isGone(readVolume(volumeId));

test.provider(
  "volume lifecycle: create formatted, grow and retag in place, replace on shrink, destroy",
  (stack) => {
    const tag = testName(stack.stage, "volume");
    return Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        DigitalOcean.Volume("Data", {
          region: REGION,
          sizeGigabytes: 1,
          filesystemType: "ext4",
          tags: [tag],
        }),
      );
      expect(created).toMatchObject({
        region: REGION,
        sizeGigabytes: 1,
        filesystemType: "ext4",
        dropletIds: [],
        tags: [tag],
      });
      const remote = yield* readVolume(created.volumeId);
      const ownershipTag = yield* hashOwnershipTag(stack.name, stack.stage, "Data");
      expect(remote.tags ?? []).toContain(ownershipTag);
      expect(remote.tags ?? []).toContain(tag);

      const grown = yield* stack.deploy(
        DigitalOcean.Volume("Data", {
          region: REGION,
          sizeGigabytes: 2,
          filesystemType: "ext4",
        }),
      );
      expect(grown.volumeId).toEqual(created.volumeId);
      expect(grown.sizeGigabytes).toEqual(2);
      expect(grown.tags).toEqual([]);
      const remoteGrown = yield* readVolume(created.volumeId);
      expect(remoteGrown.size_gigabytes).toEqual(2);
      expect(remoteGrown.tags ?? []).not.toContain(tag);

      const shrunk = yield* stack.deploy(
        DigitalOcean.Volume("Data", {
          region: REGION,
          sizeGigabytes: 1,
          filesystemType: "ext4",
        }),
      );
      expect(shrunk.volumeId).not.toEqual(created.volumeId);
      expect(shrunk.sizeGigabytes).toEqual(1);
      expect(yield* isVolumeGone(created.volumeId)).toBe(true);

      yield* stack.destroy();

      expect(yield* isVolumeGone(shrunk.volumeId)).toBe(true);
      expect(yield* isGone(getTag({ tag_id: ownershipTag }))).toBe(true);
      // A user tag outlives the volumes that carried it.
      expect(yield* isGone(getTag({ tag_id: tag }))).toBe(false);
    }).pipe(Effect.ensuring(Effect.ignore(ignoreNotFound(deleteTag({ tag_id: tag })))), logLevel);
  },
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider(
  "a volume created outside alchemy with the chosen name needs adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName(stack.stage, "volume-foreign");

      yield* Effect.acquireUseRelease(
        createVolume({ body: { name, region: REGION, size_gigabytes: 1 } }).pipe(
          Effect.map((response) => response.volume),
        ),
        (foreign) =>
          Effect.gen(function* () {
            const declared = DigitalOcean.Volume("Adopted", {
              name,
              region: REGION,
              sizeGigabytes: 1,
            });
            const refused = yield* stack.deploy(declared).pipe(Effect.flip);
            expect(refused).toBeInstanceOf(OwnedBySomeoneElse);

            const adopted = yield* stack.deploy(declared.pipe(adopt(true)));
            expect(adopted.volumeId).toEqual(foreign.id);

            yield* stack.destroy();

            expect(yield* isVolumeGone(foreign.id)).toBe(true);
          }),
        (foreign) => ignoreNotFound(deleteVolume({ volume_id: foreign.id })),
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider(
  "a volume whose attributes were lost is found by name and generation tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const declared = DigitalOcean.Volume("Box", { region: REGION, sizeGigabytes: 1 });
      const created = yield* stack.deploy(declared);
      yield* forgetAttributes({ stack: stack.name, stage: stack.stage, fqn: "Box" });

      const resumed = yield* stack.deploy(declared);
      expect(resumed.volumeId).toEqual(created.volumeId);

      yield* stack.destroy();

      expect(yield* isVolumeGone(created.volumeId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider(
  "a volume with a chosen name is deleted before its replacement takes the name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName(stack.stage, "volume-named");

      const created = yield* stack.deploy(
        DigitalOcean.Volume("Named", { name, region: REGION, sizeGigabytes: 2 }),
      );
      const planned = yield* stack.plan(
        DigitalOcean.Volume("Named", { name, region: REGION, sizeGigabytes: 1 }),
      );
      expect(planned.resources.Named).toMatchObject({ action: "replace", deleteFirst: true });

      const replaced = yield* stack.deploy(
        DigitalOcean.Volume("Named", { name, region: REGION, sizeGigabytes: 1 }),
      );
      expect(replaced.volumeId).not.toEqual(created.volumeId);
      expect(replaced.name).toEqual(name);
      expect(yield* isVolumeGone(created.volumeId)).toBe(true);

      yield* stack.destroy();

      expect(yield* isVolumeGone(replaced.volumeId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
