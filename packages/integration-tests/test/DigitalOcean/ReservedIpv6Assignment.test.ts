import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getReservedIPv6 } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { isGone, logLevel, skipSlow } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const REGION = "nyc3";
const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:reservedipv6assignment", "live"];
const LIVE_TIMEOUT = 600_000;

const assignedDroplet = (ip: string) =>
  getReservedIPv6({ reserved_ipv6: ip }).pipe(Effect.map((r) => r.reserved_ipv6.droplet?.id));

test.provider.skipIf(skipSlow)(
  "assign a reserved ipv6 to an ipv6 droplet, unassign on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const host = yield* DigitalOcean.Droplet("Host", {
            region: REGION,
            size: "s-1vcpu-512mb-10gb",
            image: "ubuntu-24-04-x64",
            ipv6: true,
          });
          const ip = yield* DigitalOcean.ReservedIpv6("Ip", { region: REGION });
          const assignment = yield* DigitalOcean.ReservedIpv6Assignment("Assignment", {
            ip: ip.ip,
            dropletId: host.dropletId,
          });
          return { host, ip, assignment };
        }),
      );
      expect(yield* assignedDroplet(deployed.ip.ip)).toEqual(deployed.host.dropletId);

      yield* stack.destroy();

      expect(yield* isGone(getReservedIPv6({ reserved_ipv6: deployed.ip.ip }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
