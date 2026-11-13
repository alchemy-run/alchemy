import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getUptimeCheck } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { logLevel } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:monitoring", "live"];
const LIVE_TIMEOUT = 120_000;

// The uptime API answers a missing id with 403, typed as UptimeCheckNotFound.
const isCheckGone = (checkId: string) =>
  getUptimeCheck({ check_id: checkId }).pipe(
    Effect.as(false),
    Effect.catchTag(["NotFound", "UptimeCheckNotFound"], () => Effect.succeed(true)),
  );

test.provider(
  "uptime check lifecycle: create, change target, regions and enabled in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        DigitalOcean.Monitoring.UptimeCheck("Site", {
          type: "https",
          target: "https://example.com",
        }),
      );
      expect(created).toMatchObject({
        type: "https",
        target: "https://example.com",
        enabled: true,
      });
      expect([...created.regions].sort()).toEqual(["eu_west", "se_asia", "us_east", "us_west"]);

      const updated = yield* stack.deploy(
        DigitalOcean.Monitoring.UptimeCheck("Site", {
          type: "https",
          target: "https://example.org",
          regions: ["us_east"],
          enabled: false,
        }),
      );
      expect(updated.checkId).toEqual(created.checkId);
      expect((yield* getUptimeCheck({ check_id: created.checkId })).check).toMatchObject({
        target: "https://example.org",
        regions: ["us_east"],
        enabled: false,
      });

      yield* stack.destroy();

      expect(yield* isCheckGone(created.checkId)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
