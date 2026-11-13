import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getReservedIP } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { isGone, logLevel, skipSlow } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const REGION = "sfo3";
const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:reservedipassignment", "live"];
// Two droplets take a few minutes to create and destroy.
const LIVE_TIMEOUT = 600_000;

const assignedDroplet = (ip: string) =>
  getReservedIP({ reserved_ip: ip }).pipe(Effect.map((r) => r.reserved_ip.droplet?.id));

const host = (name: string) =>
  DigitalOcean.Droplet(name, {
    region: REGION,
    size: "s-1vcpu-512mb-10gb",
    image: "ubuntu-24-04-x64",
  });

test.provider.skipIf(skipSlow)(
  "assign a reserved ip, move it to another droplet in place, unassign on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const assignTo = (target: "First" | "Second") =>
        Effect.gen(function* () {
          const first = yield* host("First");
          const second = yield* host("Second");
          const ip = yield* DigitalOcean.ReservedIp("Ip", { region: REGION });
          const assignment = yield* DigitalOcean.ReservedIpAssignment("Assignment", {
            ip: ip.ip,
            dropletId: (target === "First" ? first : second).dropletId,
          });
          return { first, second, ip, assignment };
        });

      const onFirst = yield* stack.deploy(assignTo("First"));
      expect(yield* assignedDroplet(onFirst.ip.ip)).toEqual(onFirst.first.dropletId);

      const moved = yield* stack.plan(assignTo("Second"));
      expect(moved.resources.Assignment).toMatchObject({ action: "update" });

      const onSecond = yield* stack.deploy(assignTo("Second"));
      expect(onSecond.ip.ip).toEqual(onFirst.ip.ip);
      expect(yield* assignedDroplet(onSecond.ip.ip)).toEqual(onSecond.second.dropletId);

      yield* stack.destroy();

      expect(yield* isGone(getReservedIP({ reserved_ip: onFirst.ip.ip }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
