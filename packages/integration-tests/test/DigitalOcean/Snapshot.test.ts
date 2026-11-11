import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getSnapshot } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isGone, logLevel, skipSlow } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:snapshots", "live"];

// A Droplet snapshot takes a few minutes.
test.provider.skipIf(skipSlow)(
  "droplet and volume snapshots: take, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const host = yield* DigitalOcean.Droplet("Host", {
            region: "nyc3",
            size: "s-1vcpu-512mb-10gb",
            image: "ubuntu-24-04-x64",
          });
          const data = yield* DigitalOcean.Volume("Data", { region: "nyc3", sizeGigabytes: 1 });
          const dropletSnap = yield* DigitalOcean.DropletSnapshot("HostSnap", {
            dropletId: host.dropletId,
          });
          const volumeSnap = yield* DigitalOcean.VolumeSnapshot("DataSnap", {
            volumeId: data.volumeId,
            tags: ["alchemy-test"],
          });
          return { droplet: dropletSnap.snapshotId, volume: volumeSnap.snapshotId };
        }),
      );
      expect(
        (yield* getSnapshot({ snapshot_id: deployed.droplet })).snapshot.resource_type,
      ).toEqual("droplet");
      expect((yield* getSnapshot({ snapshot_id: deployed.volume })).snapshot.resource_type).toEqual(
        "volume",
      );

      yield* stack.destroy();
      for (const id of [deployed.droplet, deployed.volume]) {
        expect(
          yield* isGone(getSnapshot({ snapshot_id: id })).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (gone) => gone,
              times: 12,
            }),
          ),
        ).toBe(true);
      }
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: 1_200_000 },
);
