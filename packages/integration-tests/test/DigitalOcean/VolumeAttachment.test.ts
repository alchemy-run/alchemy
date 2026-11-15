import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getVolume } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { isGone, logLevel, skipSlow } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const REGION = "sfo3";
const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:volumeattachment", "live"];
// A droplet takes one to two minutes to create and as long to destroy.
const LIVE_TIMEOUT = 600_000;

const host = (name: string) =>
  DigitalOcean.Droplet(name, {
    region: REGION,
    size: "s-1vcpu-512mb-10gb",
    image: "ubuntu-24-04-x64",
  });

const attachedTo = (volumeId: string) =>
  getVolume({ volume_id: volumeId }).pipe(
    Effect.map((response) => [...(response.volume.droplet_ids ?? [])]),
  );

test.provider.skipIf(skipSlow)(
  "attach a volume, move it to another droplet, detach on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const attachTo = (dropletLogicalId: "First" | "Second") =>
        Effect.gen(function* () {
          const first = yield* host("First");
          const second = yield* host("Second");
          const data = yield* DigitalOcean.Volume("Data", { region: REGION, sizeGigabytes: 1 });
          const target = dropletLogicalId === "First" ? first : second;
          const attachment = yield* DigitalOcean.VolumeAttachment("Attachment", {
            volumeId: data.volumeId,
            dropletId: target.dropletId,
          });
          return { first, second, data, attachment };
        });

      const onFirst = yield* stack.deploy(attachTo("First"));
      expect(onFirst.attachment.dropletId).toEqual(onFirst.first.dropletId);
      expect(yield* attachedTo(onFirst.data.volumeId)).toEqual([onFirst.first.dropletId]);

      expect((yield* stack.plan(attachTo("First"))).resources.Attachment).toMatchObject({
        action: "noop",
      });

      const onSecond = yield* stack.deploy(attachTo("Second"));
      expect(onSecond.attachment.dropletId).toEqual(onSecond.second.dropletId);
      expect(yield* attachedTo(onSecond.data.volumeId)).toEqual([onSecond.second.dropletId]);

      yield* stack.destroy();

      expect(yield* isGone(getVolume({ volume_id: onFirst.data.volumeId }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
