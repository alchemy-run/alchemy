import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getRegistry } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { isGone, logLevel, testName } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:registry", "live"];
const LIVE_TIMEOUT = 180_000;

// A team holds one registry, so registry tests never run alongside each other.
test.provider(
  "registry lifecycle: create on the free tier, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName(stack.stage, "registry").slice(0, 63);

      const created = yield* stack.deploy(DigitalOcean.Registry("Registry", { name }));
      expect(created).toMatchObject({
        name,
        endpoint: `registry.digitalocean.com/${name}`,
        tier: "starter",
      });
      expect((yield* getRegistry({ registry_name: name })).registry.name).toEqual(name);

      yield* stack.destroy();

      expect(yield* isGone(getRegistry({ registry_name: name }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT, exclusive: "digitalocean:registry" },
);
