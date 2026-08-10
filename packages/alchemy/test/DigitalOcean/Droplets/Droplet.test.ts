import * as DigitalOcean from "@/DigitalOcean";
import * as Test from "@/Test/Alchemy";
import { dropletsGet } from "@distilled.cloud/digitalocean/droplets";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasDigitalOceanCreds = !!(
  process.env.DIGITALOCEAN_TOKEN || process.env.DIGITALOCEAN_ACCESS_TOKEN
);

// Out-of-band verification context: raw distilled calls, credentials from
// env — independent of the provider layer under test.
const outOfBand = Effect.provide(
  Layer.mergeAll(DigitalOcean.CredentialsFromEnv, FetchHttpClient.layer),
);

const DROPLET_NAME = "alchemy-test-droplet";
const RENAMED = "alchemy-test-droplet-renamed";
// Cheapest size/image that exists in every region — a live droplet bills by
// the minute, so this suite creates exactly one and always destroys it.
const REGION = "sfo3";
const SIZE = "s-1vcpu-512mb-10gb";
const IMAGE = "ubuntu-24-04-x64";

test.provider.skipIf(!hasDigitalOceanCreds)(
  "droplet lifecycle: create active with an IP, rename in place, destroy",
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
      // Reconcile waits for "active", so the public IP must be present.
      expect(created.name).toEqual(DROPLET_NAME);
      expect(created.status).toEqual("active");
      expect(created.region).toEqual(REGION);
      expect(created.sizeSlug).toEqual(SIZE);
      expect(created.ipv4).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(created.tags).toEqual(["alchemy-test"]);

      // Out-of-band: the droplet exists and carries the ownership marker
      // tag alongside the user tag.
      const remote = yield* dropletsGet({ droplet_id: created.dropletId }).pipe(
        outOfBand,
      );
      expect(remote.droplet?.name).toEqual(DROPLET_NAME);
      expect(remote.droplet?.tags.some((t) => t.startsWith("alchemy:"))).toBe(
        true,
      );

      // Same logical id, new name — an in-place rename action; the physical
      // droplet (and its IP) must survive.
      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DigitalOcean.Droplet("TestDroplet", {
            name: RENAMED,
            region: REGION,
            size: SIZE,
            image: IMAGE,
            tags: ["alchemy-test"],
          });
        }),
      );
      expect(renamed.dropletId).toEqual(created.dropletId);
      expect(renamed.name).toEqual(RENAMED);
      expect(renamed.ipv4).toEqual(created.ipv4);

      yield* stack.destroy();

      // Typed wait-until-gone: delete already polls until the API answers
      // NotFound, so a single probe suffices.
      const gone = yield* dropletsGet({ droplet_id: created.dropletId }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        outOfBand,
      );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 900_000 },
);
