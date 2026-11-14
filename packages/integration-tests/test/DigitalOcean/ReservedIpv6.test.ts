import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getReservedIPv6 } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { isGone, logLevel } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:reservedipv6", "live"];
const LIVE_TIMEOUT = 180_000;

test.provider(
  "reserved ipv6 lifecycle: create unassigned, replace on a new region, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(DigitalOcean.ReservedIpv6("Ip", { region: "nyc3" }));
      expect(created.ip).toMatch(/:/);
      expect(created).toMatchObject({ region: "nyc3", dropletId: undefined });

      const replaced = yield* stack.deploy(DigitalOcean.ReservedIpv6("Ip", { region: "sfo3" }));
      expect(replaced.ip).not.toEqual(created.ip);
      expect(yield* isGone(getReservedIPv6({ reserved_ipv6: created.ip }))).toBe(true);

      yield* stack.destroy();

      expect(yield* isGone(getReservedIPv6({ reserved_ipv6: replaced.ip }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
