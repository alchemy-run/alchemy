import * as DigitalOcean from "@/DigitalOcean";
import * as Test from "@/Test/Alchemy";
import { dropletsGet } from "@distilled.cloud/digitalocean/droplets";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { hasDigitalOceanCreds, logLevel, outOfBand } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const DROPLET_NAME = "alchemy-test-droplet";
const RENAMED_DROPLET_NAME = "alchemy-test-droplet-renamed";
// Cheapest size/image that exists in every region — a live droplet bills by
// the minute, so this suite creates exactly one and always destroys it.
const REGION = "sfo3";
const SIZE = "s-1vcpu-512mb-10gb";
const IMAGE = "ubuntu-24-04-x64";

test.provider.skipIf(!hasDigitalOceanCreds)(
  "droplet lifecycle: create active with an IP, rename and retag in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DigitalOcean.Droplet("TestDroplet", {
            name: DROPLET_NAME,
            region: REGION,
            size: SIZE,
            image: IMAGE,
            tags: ["alchemy-test"],
          });
        }),
      );
      expect(created.name).toEqual(DROPLET_NAME);
      expect(created.status).toEqual("active");
      expect(created.region).toEqual(REGION);
      expect(created.sizeSlug).toEqual(SIZE);
      // Reconcile waits for "active", so the public IP must be present.
      expect(created.ipv4).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(created.tags).toEqual(["alchemy-test"]);

      // Out-of-band: the droplet carries the ownership tag beside the user
      // tag.
      const remote = yield* dropletsGet({ droplet_id: created.dropletId }).pipe(
        outOfBand,
      );
      expect(remote.droplet.name).toEqual(DROPLET_NAME);
      expect(remote.droplet.tags.some((t) => t.startsWith("alchemy:"))).toBe(
        true,
      );

      // Same logical id, new name and tags — both sync in place; the
      // physical droplet (and its IP) must survive.
      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DigitalOcean.Droplet("TestDroplet", {
            name: RENAMED_DROPLET_NAME,
            region: REGION,
            size: SIZE,
            image: IMAGE,
            tags: ["alchemy-test", "alchemy-test-extra"],
          });
        }),
      );
      expect(renamed.dropletId).toEqual(created.dropletId);
      expect(renamed.name).toEqual(RENAMED_DROPLET_NAME);
      expect(renamed.ipv4).toEqual(created.ipv4);
      expect([...renamed.tags].sort()).toEqual([
        "alchemy-test",
        "alchemy-test-extra",
      ]);

      yield* stack.destroy();

      // Delete polls until the API answers NotFound, so one probe suffices.
      const gone = yield* dropletsGet({ droplet_id: created.dropletId }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        outOfBand,
      );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 900_000 },
);
