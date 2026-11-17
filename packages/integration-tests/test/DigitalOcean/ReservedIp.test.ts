import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getReservedIP } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { isGone, logLevel } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:reservedip", "live"];
const LIVE_TIMEOUT = 180_000;

test.provider(
  "reserved ip lifecycle: create unassigned, replace on a new region, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(DigitalOcean.ReservedIp("Ip", { region: "sfo3" }));
      expect(created.ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(created).toMatchObject({ region: "sfo3", dropletId: undefined });
      const remote = yield* getReservedIP({ reserved_ip: created.ip });
      expect(remote.reserved_ip.region.slug).toEqual("sfo3");

      expect(
        (yield* stack.plan(DigitalOcean.ReservedIp("Ip", { region: "sfo3" }))).resources.Ip,
      ).toMatchObject({ action: "noop" });

      const replaced = yield* stack.deploy(DigitalOcean.ReservedIp("Ip", { region: "nyc3" }));
      expect(replaced.ip).not.toEqual(created.ip);
      expect(replaced.region).toEqual("nyc3");
      expect(yield* isGone(getReservedIP({ reserved_ip: created.ip }))).toBe(true);

      yield* stack.destroy();

      expect(yield* isGone(getReservedIP({ reserved_ip: replaced.ip }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
