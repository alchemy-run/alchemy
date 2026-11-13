import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getImage } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { isGone, logLevel, skipSlow } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:image", "live"];
// An import takes a few minutes.
const LIVE_TIMEOUT = 1_200_000;

// A 20 MB image keeps the import short.
const CIRROS = "https://download.cirros-cloud.net/0.6.2/cirros-0.6.2-x86_64-disk.img";

test.provider.skipIf(skipSlow)(
  "custom image: import from a url, rename and redescribe in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const imported = yield* stack.deploy(
        DigitalOcean.Image("Cirros", { url: CIRROS, region: "nyc3", distribution: "Unknown" }),
      );
      expect(imported.status).toEqual("available");
      expect(imported.regions).toContain("nyc3");

      const updated = yield* stack.deploy(
        DigitalOcean.Image("Cirros", {
          url: CIRROS,
          region: "nyc3",
          distribution: "Unknown",
          name: "cirros-renamed",
          description: "tiny test image",
        }),
      );
      expect(updated.imageId).toEqual(imported.imageId);
      const remote = yield* getImage({ image_id: String(imported.imageId) });
      expect(remote.image).toMatchObject({
        name: "cirros-renamed",
        description: "tiny test image",
      });

      yield* stack.destroy();

      expect(yield* isGone(getImage({ image_id: String(imported.imageId) }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
